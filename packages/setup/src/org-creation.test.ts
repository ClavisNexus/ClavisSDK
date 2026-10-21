import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { orgCreationTermsFromArgs, positionals } from "./cli-args.js";
import { orgAnchorPublishStatement } from "./statements.js";
import { getClosedIncorporations, postVerifyAnchor } from "./org-api.js";
import { saveSession } from "./session-store.js";
import { createSetupClient } from "./setup-client.js";
import type { SetupOrigins } from "./types.js";

const origins: SetupOrigins = {
  apiOrigin: "https://api.test",
  idOrigin: "https://id.test",
  developersOrigin: "https://developers.test",
};

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Route = (call: Call) => { status?: number; body: unknown } | undefined;

let calls: Call[] = [];
let dir = "";
let sessionPath = "";

function stubApi(route: Route): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        path: new URL(url).pathname,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const res = route(call);
      if (!res) throw new Error(`unexpected ${call.method} ${call.path}`);
      return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
    }),
  );
}

function paths(): string[] {
  return calls.map((c) => `${c.method} ${c.path}`);
}

function client() {
  return createSetupClient({ origins, sessionPath, openBrowser: false });
}

const challenge = {
  domain: "example.com",
  kind: "anchor",
  nonce: "n1",
  exp: 2_000_000_000,
  statement: {} as Record<string, unknown>,
  well_known_url: "https://example.com/.well-known/clavis-anchor.json",
  txt_host: "_clavis.example.com",
};

beforeAll(async () => {
  // org-anchor-plan は、challenge の文型を手元で組み立て直して照らします。
  challenge.statement = orgAnchorPublishStatement(challenge);
});

beforeEach(async () => {
  calls = [];
  dir = await mkdtemp(join(tmpdir(), "clavis-setup-test-"));
  sessionPath = join(dir, "session.json");
  await saveSession({ accessToken: "tok", sub: "sub-1" }, origins, sessionPath);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("org-api", () => {
  it("reads closed places without a bearer", async () => {
    stubApi((c) =>
      c.path === "/orgs/regions" ? { body: { payload: { closed_incorporations: ["GB-EAW", 3, "DE"] } } } : undefined,
    );
    expect(await getClosedIncorporations(origins.apiOrigin)).toEqual(["GB-EAW", "DE"]);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("sends accept_customer_terms false unless the caller passes true", async () => {
    stubApi(() => ({ body: { org_id: "o1", primary_domain: "example.com", org_status: "active" } }));
    await postVerifyAnchor(origins.apiOrigin, "tok", { domain: "example.com", nonce: "n1", incorporation: "JP" });
    expect(calls[0]!.body).toEqual({ domain: "example.com", nonce: "n1", accept_customer_terms: false, incorporation: "JP" });
  });
});

describe("orgAnchorPlan", () => {
  it("refuses without the customer's agreement before any request", async () => {
    stubApi(() => undefined);
    const out = await client().orgAnchorPlan("example.com", undefined, { incorporation: "JP" });
    expect(out).toMatchObject({ ok: false, error: "customer_terms_not_accepted", human: { needs_human: "terms" } });
    expect(calls).toEqual([]);
  });

  it("refuses without a place of incorporation", async () => {
    stubApi(() => undefined);
    const out = await client().orgAnchorPlan("example.com", undefined, { acceptCustomerTerms: true });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/^incorporation_required/);
    expect(calls).toEqual([]);
  });

  it("refuses a closed place before the challenge and Passkey", async () => {
    stubApi((c) =>
      c.path === "/orgs/regions" ? { body: { payload: { closed_incorporations: ["GB-EAW"] } } } : undefined,
    );
    const out = await client().orgAnchorPlan("example.com", undefined, {
      incorporation: " gb-eaw ",
      acceptCustomerTerms: true,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/^region_closed — .*GB-EAW/);
    expect(paths()).toEqual(["GET /orgs/regions"]);
  });

  it("maps 403 REGION_CLOSED from the challenge when the closed list cannot be read", async () => {
    stubApi((c) => {
      if (c.path === "/orgs/regions") return { status: 503, body: { error: "INSTANCE_MANIFEST_INVALID" } };
      if (c.path === "/orgs/dns/challenge") {
        return { status: 403, body: { error: "REGION_CLOSED", message: "new organisations are not accepted" } };
      }
      return undefined;
    });
    const out = await client().orgAnchorPlan("example.com", undefined, { incorporation: "DE", acceptCustomerTerms: true });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/^region_closed — .*DE/);
    expect(paths()).toEqual(["GET /orgs/regions", "POST /orgs/dns/challenge"]);
  });

  it("sends the place to the challenge, then starts Passkey", async () => {
    stubApi((c) => {
      if (c.path === "/orgs/regions") return { body: { payload: { closed_incorporations: ["GB-EAW"] } } };
      if (c.path === "/orgs/dns/challenge") return { body: challenge };
      if (c.path === "/webauthn/authentication/ceremony/start") return { body: { payload: { ticket: "t1" } } };
      return undefined;
    });
    const out = await client().orgAnchorPlan("example.com", "Example", { incorporation: "jp", acceptCustomerTerms: true });
    expect(out).toMatchObject({ ok: true, data: { incorporation: "JP", ticket: "t1", nonce: "n1" } });
    expect(calls[1]!.body).toEqual({ domain: "example.com", kind: "anchor", incorporation: "JP" });
    expect(paths()[2]).toBe("POST /webauthn/authentication/ceremony/start");
  });
});

describe("orgVerifyAnchor", () => {
  it("refuses without the customer's agreement before any request", async () => {
    stubApi(() => undefined);
    const out = await client().orgVerifyAnchor({ domain: "example.com", nonce: "n1", incorporation: "JP" });
    expect(out).toMatchObject({ ok: false, error: "customer_terms_not_accepted", human: { needs_human: "terms" } });
    expect(calls).toEqual([]);
  });

  it("sends the place and the customer's agreement", async () => {
    stubApi(() => ({ body: { org_id: "o1", primary_domain: "example.com", org_status: "active" } }));
    const out = await client().orgVerifyAnchor({
      domain: "example.com",
      nonce: "n1",
      incorporation: "us-de",
      acceptCustomerTerms: true,
    });
    expect(out).toEqual({ ok: true, data: { org_id: "o1", org_status: "active" } });
    expect(calls[0]!.body).toEqual({
      domain: "example.com",
      nonce: "n1",
      accept_customer_terms: true,
      incorporation: "US-DE",
    });
  });

  it("maps 403 REGION_CLOSED to region_closed instead of a DNS retry", async () => {
    stubApi(() => ({ status: 403, body: { error: "REGION_CLOSED", message: "closed" } }));
    const out = await client().orgVerifyAnchor({
      domain: "example.com",
      nonce: "n1",
      incorporation: "FR",
      acceptCustomerTerms: true,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/^region_closed — .*FR/);
    expect(!out.ok && out.human).toBeUndefined();
  });

  it("keeps the DNS hint for other failures", async () => {
    stubApi(() => ({ status: 400, body: { error: "ANCHOR_TXT_MISSING", message: "TXT not found" } }));
    const out = await client().orgVerifyAnchor({
      domain: "example.com",
      nonce: "n1",
      incorporation: "JP",
      acceptCustomerTerms: true,
    });
    expect(out).toMatchObject({ ok: false, error: "TXT not found", human: { needs_human: "dns" } });
  });
});

describe("cli args", () => {
  it("agrees to the Customer Terms only when the flag is present", () => {
    expect(orgCreationTermsFromArgs(["example.com", "--incorporation", "JP"])).toEqual({
      incorporation: "JP",
      acceptCustomerTerms: false,
    });
    expect(orgCreationTermsFromArgs(["--accept-customer-terms=true"]).acceptCustomerTerms).toBe(false);
    expect(orgCreationTermsFromArgs(["--incorporation", "JP", "--accept-customer-terms"]).acceptCustomerTerms).toBe(true);
  });

  it("does not take flags or their values as the domain or name", () => {
    expect(positionals(["example.com", "--incorporation", "JP", "--accept-customer-terms"], ["--incorporation"])).toEqual([
      "example.com",
    ]);
    expect(
      positionals(["--accept-customer-terms", "example.com", "Example Org", "--incorporation", "JP"], ["--incorporation"]),
    ).toEqual(["example.com", "Example Org"]);
  });
});
