import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardCheckoutOptionsFromArgs } from "./cli-args.js";
import { orgCardCheckoutStatement, orgCardIncorporationStatement } from "./statements.js";
import { saveSession } from "./session-store.js";
import { createSetupClient } from "./setup-client.js";
import type { OrgCardView, SetupOrigins } from "./types.js";

const origins: SetupOrigins = {
  apiOrigin: "https://api.test",
  idOrigin: "https://id.test",
  developersOrigin: "https://developers.test",
};

const ORG = "550e8400-e29b-41d4-a716-446655440000";
const SUB = "sub-1";
const VERSION = "2026-10-09";
const RECEIPT = JSON.stringify({ type: "receipt@1", statement: { type: "org.card.checkout@1" } });

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

/** Passkey の ticket を出し、結果をすぐ返す ceremony です。 */
function ceremony(call: Call): { body: unknown } | undefined {
  if (call.path === "/webauthn/authentication/ceremony/start") return { body: { payload: { ticket: "t1" } } };
  if (call.path === "/webauthn/authentication/ceremony/result") return { body: { payload: { ticket: "t1", receipt: RECEIPT } } };
  return undefined;
}

function paths(): string[] {
  return calls.map((c) => `${c.method} ${c.path}`);
}

function bodyOf(path: string): unknown {
  return calls.find((c) => c.path === path)?.body;
}

function client() {
  return createSetupClient({ origins, sessionPath, openBrowser: false });
}

function cardView(over: Partial<OrgCardView> = {}): OrgCardView {
  return {
    billing_sub: "",
    month: "2026-10",
    suspended: false,
    capabilities: {
      signature: {
        open: false,
        register: false,
        blockers: ["subscription"],
        checkout_open: true,
        bundle_checkout_open: true,
        tariff: null,
      },
    },
    incorporation: { code: "JP", at: 1, customer_terms_version: VERSION, dpa_version: VERSION, terms_current: true },
    acceptance: { customer_terms_version: VERSION, dpa_version: VERSION },
    ...over,
  };
}

function cardRoutes(card: OrgCardView, closed: string[] = [], checkout?: { status?: number; body: unknown }): Route {
  return (c) => {
    if (c.path === `/orgs/${ORG}/card`) return { body: card };
    if (c.path === "/orgs/regions") return { body: { payload: { closed_incorporations: closed } } };
    if (c.path === `/orgs/${ORG}/card/checkout`) return checkout ?? { body: { url: "https://buy.polar.sh/c/1", checkout_id: "c1" } };
    return ceremony(c);
  };
}

beforeEach(async () => {
  calls = [];
  dir = await mkdtemp(join(tmpdir(), "clavis-card-test-"));
  sessionPath = join(dir, "session.json");
  await saveSession({ accessToken: "tok", sub: SUB }, origins, sessionPath);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("card statements", () => {
  const base = { org: ORG, customerTerms: VERSION, dpa: VERSION };

  it("match the platform's statements for checkout and incorporation", () => {
    expect(orgCardCheckoutStatement({ ...base, capability: "signature", offer: "meter" })).toEqual({
      type: "org.card.checkout@1",
      org: ORG,
      capability: "signature",
      offer: "meter",
      customer_terms: VERSION,
      dpa: VERSION,
    });
    expect(orgCardIncorporationStatement({ ...base, code: "JP" })).toEqual({
      type: "org.card.incorporation_set@1",
      org: ORG,
      code: "JP",
      customer_terms: VERSION,
      dpa: VERSION,
    });
  });
});

describe("cardCheckout", () => {
  it("asks for the customer's consent before Passkey and shows the statement", async () => {
    stubApi(cardRoutes(cardView()));
    const out = await client().cardCheckout(ORG);
    expect(out).toMatchObject({ ok: false, error: "billing_data_consent_required", human: { needs_human: "terms" } });
    const message = (!out.ok && out.human?.message) || "";
    expect(message).toContain("Polar Software Inc. in the United States");
    expect(message).toContain("https://legal.clavis.nexus/en/privacy");
    expect(message).toContain(`Customer Terms ${VERSION} and DPA ${VERSION}`);
    expect(message).toContain("--consent-billing-data");
    expect(paths()).toEqual([`GET /orgs/${ORG}/card`, "GET /orgs/regions"]);
  });

  it("shows the statement in Japanese for lang ja", async () => {
    stubApi(cardRoutes(cardView()));
    const out = await client().cardCheckout(ORG, { lang: "ja" });
    const message = (!out.ok && out.human?.message) || "";
    expect(message).toContain("米国の Polar Software Inc. に提供することに同意します");
    expect(message).toContain("https://legal.clavis.nexus/ja/privacy");
  });

  it("signs the checkout with Passkey and sends the consent, offer, and language", async () => {
    stubApi(cardRoutes(cardView()));
    const out = await client().cardCheckout(ORG, { consentBillingData: true });
    expect(out).toMatchObject({ ok: true, data: { url: "https://buy.polar.sh/c/1", human: { needs_human: "payment" } } });
    expect(bodyOf("/webauthn/authentication/ceremony/start")).toEqual({
      statement: orgCardCheckoutStatement({ org: ORG, capability: "signature", offer: "meter", customerTerms: VERSION, dpa: VERSION }),
      return_to: "https://developers.test/developers/setup/ceremony",
    });
    expect(bodyOf(`/orgs/${ORG}/card/checkout`)).toEqual({
      capability: "signature",
      offer: "meter",
      consent: { polar_provision: true },
      ui_locale: "en",
      receipt: RECEIPT,
    });
  });

  it("binds the bundle offer and the shown language", async () => {
    stubApi(cardRoutes(cardView()));
    const out = await client().cardCheckout(ORG, { consentBillingData: true, offer: "bundle", lang: "ja" });
    expect(out.ok).toBe(true);
    expect(bodyOf("/webauthn/authentication/ceremony/start")).toMatchObject({
      statement: { type: "org.card.checkout@1", offer: "bundle" },
    });
    expect(bodyOf(`/orgs/${ORG}/card/checkout`)).toMatchObject({ offer: "bundle", ui_locale: "ja" });
  });

  it("needs a place of incorporation on the current Customer Terms first", async () => {
    stubApi(cardRoutes(cardView({ incorporation: null })));
    const missing = await client().cardCheckout(ORG, { consentBillingData: true });
    expect(missing).toMatchObject({ ok: false, error: "incorporation_required", human: { needs_human: "terms" } });
    expect(!missing.ok && missing.human?.message).toContain(`clavis incorporation-set ${ORG}`);

    calls = [];
    const stale = cardView();
    stale.incorporation = { ...stale.incorporation!, terms_current: false };
    stubApi(cardRoutes(stale));
    expect(await client().cardCheckout(ORG, { consentBillingData: true })).toMatchObject({
      ok: false,
      error: "incorporation_stale",
    });
    expect(paths()).toEqual([`GET /orgs/${ORG}/card`]);
  });

  it("refuses a closed place of incorporation before Passkey", async () => {
    stubApi(cardRoutes(cardView(), ["JP"]));
    const out = await client().cardCheckout(ORG, { consentBillingData: true });
    expect(!out.ok && out.error).toMatch(/^region_closed — .*JP/);
    expect(paths()).toEqual([`GET /orgs/${ORG}/card`, "GET /orgs/regions"]);
  });

  it("does not start a subscription the card already has", async () => {
    const card = cardView();
    card.capabilities.signature = { ...card.capabilities.signature!, open: true, blockers: [], tariff: "meter" };
    stubApi(cardRoutes(card));
    const meter = await client().cardCheckout(ORG, { consentBillingData: true });
    expect(!meter.ok && meter.error).toMatch(/^already_subscribed/);
    // 従量から月額の束へは移れます
    const bundle = await client().cardCheckout(ORG, { consentBillingData: true, offer: "bundle" });
    expect(bundle.ok).toBe(true);
  });

  it("maps an account without an age record after Passkey", async () => {
    stubApi(
      cardRoutes(cardView(), [], {
        status: 400,
        body: { error: "AGE_BAND_REQUIRED", message: "account age band is required for checkout" },
      }),
    );
    const out = await client().cardCheckout(ORG, { consentBillingData: true });
    expect(!out.ok && out.error).toMatch(/^age_band_required/);
  });

  it("rejects a checkout URL that is not on the card checkout host", async () => {
    stubApi(cardRoutes(cardView(), [], { body: { url: "https://evil.example/pay" } }));
    const out = await client().cardCheckout(ORG, { consentBillingData: true });
    expect(out).toEqual({ ok: false, error: "checkout URL host is not allowed" });
  });
});

describe("incorporationSet", () => {
  it("refuses without the customer's agreement before any request", async () => {
    stubApi(() => undefined);
    const out = await client().incorporationSet({ orgId: ORG, incorporation: "JP" });
    expect(out).toMatchObject({ ok: false, error: "customer_terms_not_accepted", human: { needs_human: "terms" } });
    expect(!out.ok && out.human?.message).toMatch(/^Declaring the place of incorporation/);
    expect(calls).toEqual([]);
  });

  it("skips Passkey when the declaration is already on the current terms", async () => {
    stubApi(cardRoutes(cardView()));
    const out = await client().incorporationSet({ orgId: ORG, incorporation: "jp", acceptCustomerTerms: true });
    expect(out).toMatchObject({ ok: true, data: { unchanged: true, incorporation: { code: "JP" } } });
    expect(paths()).toEqual([`GET /orgs/${ORG}/card`]);
  });

  it("declares the current place again on new terms, even while that place is closed", async () => {
    const stale = cardView();
    stale.incorporation = { ...stale.incorporation!, terms_current: false };
    const saved = { ...stale.incorporation, terms_current: true };
    stubApi((c) => {
      if (c.path === `/orgs/${ORG}/card/incorporation`) return { body: { ok: true, incorporation: saved } };
      return cardRoutes(stale, ["JP"])(c);
    });
    const out = await client().incorporationSet({ orgId: ORG, incorporation: "JP", acceptCustomerTerms: true });
    expect(out).toEqual({ ok: true, data: { incorporation: saved } });
    expect(bodyOf("/webauthn/authentication/ceremony/start")).toMatchObject({
      statement: { type: "org.card.incorporation_set@1", org: ORG, code: "JP" },
    });
    expect(bodyOf(`/orgs/${ORG}/card/incorporation`)).toEqual({ code: "JP", receipt: RECEIPT });
  });

  it("refuses a closed place that is not the current one before Passkey", async () => {
    stubApi(cardRoutes(cardView(), ["GB-EAW"]));
    const out = await client().incorporationSet({ orgId: ORG, incorporation: "gb-eaw", acceptCustomerTerms: true });
    expect(!out.ok && out.error).toMatch(/^region_closed — GB-EAW/);
    expect(paths()).toEqual([`GET /orgs/${ORG}/card`, "GET /orgs/regions"]);
  });
});

describe("status", () => {
  function statusRoutes(card: OrgCardView): Route {
    return (c) => {
      if (c.path === "/orgs") {
        return {
          body: {
            orgs: [{ org_id: ORG, name: "Example", role: "owner", primary_domain: "example.com", org_status: "anchor_verified", capabilities: [] }],
          },
        };
      }
      if (c.path === `/orgs/${ORG}`) return { body: { org_id: ORG, setup_complete: true, primary_domain: "example.com" } };
      if (c.path === `/orgs/${ORG}/card`) return { body: card };
      if (c.path === `/orgs/${ORG}/apps`) return { body: { apps: [] } };
      return undefined;
    };
  }

  it("reports an open signature card as active, with the place of incorporation", async () => {
    const card = cardView();
    card.capabilities.signature = { ...card.capabilities.signature!, open: true, register: true, blockers: [] };
    stubApi(statusRoutes(card));
    const out = await client().status();
    expect(out.ok && out.data.orgs[0]).toMatchObject({ signature_card: "active", incorporation: { code: "JP", terms_current: true } });
    expect(out.ok && out.data.orgs[0]?.signature_card_blockers).toBeUndefined();
  });

  it("reports what holds the card back", async () => {
    const card = cardView({ incorporation: null });
    card.capabilities.signature = { ...card.capabilities.signature!, blockers: ["payment_failed"] };
    stubApi(statusRoutes(card));
    const out = await client().status();
    expect(out.ok && out.data.orgs[0]).toMatchObject({
      signature_card: "inactive",
      signature_card_blockers: ["payment_failed"],
      incorporation: null,
    });
  });
});

describe("appRegister", () => {
  it("registers the generic_sign intent type", async () => {
    vi.stubEnv("CLAVIS_OPERATE_KEYS_DIR", join(dir, "apps"));
    stubApi((c) => {
      if (c.method === "GET" && c.path === `/orgs/${ORG}`) return { body: { org_id: ORG, primary_domain: "example.com" } };
      if (c.path === `/orgs/${ORG}/policy/bootstrap`) return { body: { policy_revision_hash: "h", already_active: true } };
      if (c.method === "POST" && c.path === `/orgs/${ORG}/apps`) {
        return { status: 201, body: { app_id: "app-1", host: "app.example.com", status: "pending_host" } };
      }
      return ceremony(c);
    });
    const out = await client().appRegister({ orgId: ORG, host: "app.example.com", displayName: "App" });
    expect(out).toMatchObject({ ok: true, data: { app_id: "app-1" } });
    expect(bodyOf(`/orgs/${ORG}/apps`)).toMatchObject({ intent_types: ["generic_sign"], max_ttl_seconds: 300 });
  });
});

describe("card-checkout args", () => {
  it("consents only when the flag is present", () => {
    expect(cardCheckoutOptionsFromArgs([ORG])).toEqual({ ok: true, options: { consentBillingData: false } });
    expect(cardCheckoutOptionsFromArgs([ORG, "--consent-billing-data=true"])).toMatchObject({
      options: { consentBillingData: false },
    });
    expect(cardCheckoutOptionsFromArgs([ORG, "--offer", "bundle", "--lang", "ja", "--consent-billing-data"])).toEqual({
      ok: true,
      options: { offer: "bundle", lang: "ja", consentBillingData: true },
    });
  });

  it("rejects an unknown offer or language", () => {
    expect(cardCheckoutOptionsFromArgs(["--offer", "yearly"]).ok).toBe(false);
    expect(cardCheckoutOptionsFromArgs(["--lang", "fr"]).ok).toBe(false);
  });
});
