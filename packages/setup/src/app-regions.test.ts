import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseAppRegions, readAppRegionsInput } from "./app-regions.js";
import { appRegionsFromArgs } from "./cli-args.js";
import { orgAppRegionsStatement } from "./statements.js";
import { saveSession } from "./session-store.js";
import { createSetupClient } from "./setup-client.js";
import type { OrgAppSummary, SetupOrigins } from "./types.js";

const origins: SetupOrigins = {
  apiOrigin: "https://api.test",
  idOrigin: "https://id.test",
  developersOrigin: "https://developers.test",
};

const ORG = "550e8400-e29b-41d4-a716-446655440000";
const APP = "app-1";
const SUB = "sub-1";
const RECEIPT = JSON.stringify({ type: "receipt@1", statement: { type: "org.app.regions@1" } });

type Call = { method: string; path: string; body: unknown };
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

function bodyOf(path: string): unknown {
  return calls.find((c) => c.path === path && c.method !== "GET")?.body;
}

function client() {
  return createSetupClient({ origins, sessionPath, openBrowser: false });
}

function app(over: Partial<OrgAppSummary> = {}): OrgAppSummary {
  return {
    app_id: APP,
    org_id: ORG,
    host: "app.example.com",
    display_name: "App",
    status: "active",
    intent_types: ["generic_sign"],
    ...over,
  };
}

const REGIONS_PATH = `/orgs/${ORG}/apps/${APP}/regions`;

function routes(opts: {
  app?: OrgAppSummary;
  selectable?: string[] | "unreadable";
  put?: { status?: number; body: unknown };
}): Route {
  return (c) => {
    if (c.method === "GET" && c.path === `/orgs/${ORG}/apps/${APP}`) return { body: { app: opts.app ?? app() } };
    if (c.path === "/orgs/regions") {
      if (opts.selectable === "unreadable") return { status: 503, body: { error: "INSTANCE_MANIFEST_INVALID" } };
      return { body: { payload: { closed_incorporations: [], app_regions: opts.selectable ?? ["JP", "US"] } } };
    }
    if (c.method === "PUT" && c.path === REGIONS_PATH) {
      return opts.put ?? { body: { app_id: APP, accepted_regions: (c.body as { accepted_regions: unknown }).accepted_regions } };
    }
    if (c.path === "/webauthn/authentication/ceremony/start") return { body: { payload: { ticket: "t1" } } };
    if (c.path === "/webauthn/authentication/ceremony/result") return { body: { payload: { ticket: "t1", receipt: RECEIPT } } };
    return undefined;
  };
}

beforeEach(async () => {
  calls = [];
  dir = await mkdtemp(join(tmpdir(), "clavis-regions-test-"));
  sessionPath = join(dir, "session.json");
  await saveSession({ accessToken: "tok", sub: SUB }, origins, sessionPath);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("regions statement", () => {
  it("matches the platform's statement for a list and for clearing (no duplicates, sorted, null clears)", () => {
    expect(orgAppRegionsStatement({ org: ORG, app: APP, regions: ["US", "EEA", "JP"] })).toEqual({
      type: "org.app.regions@1",
      org: ORG,
      app: APP,
      regions: ["EEA", "JP", "US"],
    });
    expect(orgAppRegionsStatement({ org: ORG, app: APP, regions: null }).regions).toBeNull();
  });
});

describe("readAppRegionsInput", () => {
  it("normalises case and sorts into the saved order", () => {
    expect(readAppRegionsInput([" eea", "jp", "US"])).toEqual({ ok: true, regions: ["JP", "US", "EEA"] });
    expect(readAppRegionsInput(null)).toEqual({ ok: true, regions: null });
  });

  it("refuses an empty list, a repeat, or an unknown region", () => {
    for (const raw of [[], ["JP", "jp"], ["DE"], ["UK"]]) {
      expect(readAppRegionsInput(raw)).toMatchObject({ ok: false, error: expect.stringMatching(/^regions_invalid/) });
    }
  });
});

describe("app-regions-set args", () => {
  it("takes either a comma-separated list or --all", () => {
    expect(appRegionsFromArgs([ORG, APP, "--regions", "JP,US"])).toEqual({ ok: true, regions: ["JP", "US"] });
    expect(appRegionsFromArgs([ORG, APP, "--all"])).toEqual({ ok: true, regions: null });
  });

  it("refuses neither or both", () => {
    expect(appRegionsFromArgs([ORG, APP])).toMatchObject({ ok: false, error: expect.stringMatching(/^regions_required/) });
    expect(appRegionsFromArgs([ORG, APP, "--regions", "JP", "--all"])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^regions_conflict/),
    });
    expect(chooseAppRegions({ regions: ["JP"], all: true }).ok).toBe(false);
  });
});

describe("appRegionsSet", () => {
  it("refuses an invalid list before any request", async () => {
    stubApi(() => undefined);
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["FR"] });
    expect(!out.ok && out.error).toMatch(/^regions_invalid/);
    expect(calls).toEqual([]);
  });

  it("signs the list with Passkey and saves it", async () => {
    stubApi(routes({}));
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["us", "jp"] });
    expect(out).toEqual({ ok: true, data: { accepted_regions: ["JP", "US"] } });
    expect(bodyOf("/webauthn/authentication/ceremony/start")).toEqual({
      statement: { type: "org.app.regions@1", org: ORG, app: APP, regions: ["JP", "US"] },
      return_to: "https://developers.test/developers/setup/ceremony",
    });
    expect(bodyOf(REGIONS_PATH)).toEqual({ accepted_regions: ["JP", "US"], receipt: RECEIPT });
  });

  it("clears the list with null", async () => {
    stubApi(routes({ app: app({ accepted_regions: ["JP"] }) }));
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: null });
    expect(out).toEqual({ ok: true, data: { accepted_regions: null } });
    expect(bodyOf("/webauthn/authentication/ceremony/start")).toMatchObject({
      statement: { type: "org.app.regions@1", regions: null },
    });
    expect(bodyOf(REGIONS_PATH)).toEqual({ accepted_regions: null, receipt: RECEIPT });
    // 解除は地域の一覧を読みません
    expect(paths()).not.toContain("GET /orgs/regions");
  });

  it("skips Passkey when the App already has that list", async () => {
    stubApi(routes({ app: app({ accepted_regions: ["JP", "US"] }) }));
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["US", "JP"] });
    expect(out).toEqual({ ok: true, data: { accepted_regions: ["JP", "US"], unchanged: true } });
    expect(paths()).toEqual([`GET /orgs/${ORG}/apps/${APP}`]);

    calls = [];
    stubApi(routes({}));
    expect(await client().appRegionsSet({ orgId: ORG, appId: APP, regions: null })).toMatchObject({
      ok: true,
      data: { unchanged: true },
    });
  });

  it("refuses a region Clavis does not accept now before Passkey", async () => {
    stubApi(routes({ selectable: ["JP", "US"] }));
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["JP", "EEA"] });
    expect(!out.ok && out.error).toMatch(/^region_not_open — .*EEA.*Regions you can choose now: JP, US\./);
    expect(paths()).toEqual([`GET /orgs/${ORG}/apps/${APP}`, "GET /orgs/regions"]);
  });

  it("refuses a disabled App before Passkey", async () => {
    stubApi(routes({ app: app({ status: "disabled" }) }));
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["JP"] });
    expect(!out.ok && out.error).toMatch(/^app_disabled/);
    expect(paths()).toEqual([`GET /orgs/${ORG}/apps/${APP}`]);
  });

  it("leaves the check to the API when the region list cannot be read, and maps its refusal", async () => {
    stubApi(
      routes({
        selectable: "unreadable",
        put: { status: 400, body: { error: "REGION_NOT_OPEN", message: "accepted_regions includes a region Clavis does not accept now" } },
      }),
    );
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["GB"] });
    expect(!out.ok && out.error).toMatch(/^region_not_open — .*GB/);
    expect(paths()).toContain(`PUT ${REGIONS_PATH}`);
  });

  it("maps a member without the owner or admin role", async () => {
    stubApi(routes({ put: { status: 403, body: { error: "FORBIDDEN", message: "insufficient role" } } }));
    const out = await client().appRegionsSet({ orgId: ORG, appId: APP, regions: ["JP"] });
    expect(!out.ok && out.error).toMatch(/^forbidden/);
  });
});

describe("status", () => {
  it("reports the App's regions only when it has a list", async () => {
    stubApi((c) => {
      if (c.path === "/orgs") {
        return {
          body: {
            orgs: [{ org_id: ORG, name: "Example", role: "owner", primary_domain: "example.com", org_status: "anchor_verified", capabilities: [] }],
          },
        };
      }
      if (c.path === `/orgs/${ORG}`) return { body: { org_id: ORG, setup_complete: true, primary_domain: "example.com" } };
      if (c.path === `/orgs/${ORG}/card`) return { status: 404, body: { error: "NOT_FOUND" } };
      if (c.path === `/orgs/${ORG}/apps`) {
        const declaration = { endUsers: "staff", uses: [{ capability: "signature", operation: "approve" }] };
        return {
          body: {
            apps: [
              app({ declaration, accepted_regions: ["JP"] }),
              app({ app_id: "app-2", host: "two.example.com", declaration }),
            ],
          },
        };
      }
      return undefined;
    });
    const out = await client().status();
    const apps = out.ok ? out.data.orgs[0]?.apps : [];
    expect(apps?.[0]).toMatchObject({ app_id: APP, accepted_regions: ["JP"] });
    expect(apps?.[1]).not.toHaveProperty("accepted_regions");
  });
});
