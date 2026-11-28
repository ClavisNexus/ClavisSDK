import { decodeJwt, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createAppClient, type PendingLink, type VerifiedReceipt } from "./index.js";
import { API_ORIGIN, APP_RECEIPT, APP_STATEMENT, MASTER, PAIRWISE, fakeNet, jsonResponse, vectorVerifiers } from "./test-fixtures.js";

const APP_ID = APP_STATEMENT.app;
const REQUEST = APP_STATEMENT.request;
const VERIFIERS = await vectorVerifiers();

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.alg = "EdDSA";
  return JSON.stringify(jwk);
}

const registered = (extra: Record<string, unknown> = {}) => ({
  payload: {
    request_id: REQUEST,
    display_code: "AB12CD34EF",
    consume_url: `${API_ORIGIN}/app/intent-requests/consume/${REQUEST}`,
    link_consume_url: `${API_ORIGIN}/app/intent-requests/consume-link/${REQUEST}`,
    poll_secret: "poll-secret",
    ...extra,
  },
});

/** 登録と status を答える App の API。`status` は status の本文（`{ payload }` の中身） */
async function clientFor(answer: { register?: unknown; status?: () => unknown } = {}) {
  const posted: string[] = [];
  const reportedReturnCodes: (string | null)[] = [];
  const net = fakeNet((url, init) => {
    if (url.pathname === "/app/intent-requests/register") {
      posted.push(String(init?.body));
      return jsonResponse(answer.register ?? registered());
    }
    if (url.pathname.startsWith("/app/intent-requests/status/")) {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Intent-Poll-Secret")).toBe("poll-secret");
      reportedReturnCodes.push(headers.get("X-Intent-Return-Code"));
      return jsonResponse({ payload: answer.status?.() ?? { state: "pending", request_id: REQUEST } });
    }
    return null;
  });
  const client = createAppClient({
    apiOrigin: API_ORIGIN,
    appId: APP_ID,
    operatePrivateJwk: await operateJwk(),
    trustRoot: MASTER,
    verifiers: VERIFIERS,
    fetchImpl: net.fetchImpl,
  });
  return { client, posted, net, reportedReturnCodes };
}

const pendingFor = (extra: Partial<PendingLink> = {}): PendingLink => ({
  requestId: REQUEST,
  pollSecret: "poll-secret",
  appUser: "staff-01",
  nonce: "6f1d0a52-3c8e-4b7a-9d2f-1e5b8c4a7d90",
  iss: API_ORIGIN,
  ...extra,
});

/** 照合器が federation.link@1 の受領として読んだもの（照合器の答えの形） */
function linkReceipt(statement: Record<string, unknown> = {}, over: Partial<VerifiedReceipt> = {}): VerifiedReceipt {
  const p = pendingFor();
  return {
    receipt: "{\"type\":\"receipt.app@1\"}",
    type: "receipt.app@1",
    statement: { type: "federation.link@1", request: REQUEST, app: APP_ID, app_user: p.appUser, nonce: p.nonce, iss: p.iss, ...statement },
    envelope: { aud: `request:${REQUEST}`, signer: PAIRWISE, iat: 1791747759, dimension: "sha256:d", statement: "sha256:s" },
    dimension: { digest: "sha256:d", name: "relation", verifier: "sha256:v", registry: "sha256:r", signer: "pairwise" },
    accepted: [{ kid: "clavis-sign-receipt-test", at: 1791747761 }],
    anchor: { log: "first-party.0", index: 42, origin: "clavis.nexus/ledger/first-party.0", leafHash: "h", state: "anchored", size: 43, time: 1791747800 },
    verifier: "sha256:v",
    catalogStale: false,
    ...over,
  };
}

const completed = () => ({ state: "completed", request_id: REQUEST, intent_type: "generic_sign", receipt: APP_RECEIPT });

describe("registerLink", () => {
  it("registers link_params for the user and nothing to sign besides them", async () => {
    const { client, posted } = await clientFor();
    const result = await client.registerLink({
      appUser: " Ａlicé ",
      returnUrl: "https://app.example/settings/clavis",
      uiLocales: ["ja"],
    });
    const claims = decodeJwt((JSON.parse(posted[0]!) as { registration: string }).registration);
    const appUser = "Ａlicé".normalize("NFC");
    expect(claims.iss).toBe(`app:${APP_ID}`);
    expect(claims.aud).toBe("app-intent-registration");
    expect(claims.intent_type).toBe("generic_sign");
    expect(claims.link_params).toEqual({ app_id: APP_ID, app_user_id: appUser, link_nonce: result.pending.nonce, iss: API_ORIGIN });
    expect(claims.return_url).toBe("https://app.example/settings/clavis");
    expect(claims.ui_locales).toEqual(["ja"]);
    expect(claims).not.toHaveProperty("payload");
    expect(claims).not.toHaveProperty("payload_sha256");
    expect(claims.exp).toBe((claims.iat as number) + 120);
    expect(result).toEqual({
      requestId: REQUEST,
      consumeUrl: `${API_ORIGIN}/app/intent-requests/consume-link/${REQUEST}`,
      displayCode: "AB12CD34EF",
      pending: { requestId: REQUEST, pollSecret: "poll-secret", appUser, nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), iss: API_ORIGIN },
    });
  });

  it("names the signer when allowedSub is given", async () => {
    const { client, posted } = await clientFor();
    await client.registerLink({ appUser: "staff-01", allowedSub: PAIRWISE });
    expect(decodeJwt((JSON.parse(posted[0]!) as { registration: string }).registration).allowed_sub).toBe(PAIRWISE);
    await expect(client.registerLink({ appUser: "staff-01", allowedSub: "has space" })).rejects.toMatchObject({ code: "invalid_allowed_sub" });
  });

  it("refuses an appUser Clavis would not take before sending", async () => {
    const { client, posted } = await clientFor();
    for (const appUser of ["", "   ", "a".repeat(129), "tab\there", "lone\ud800", 7 as unknown as string]) {
      await expect(client.registerLink({ appUser })).rejects.toMatchObject({ code: "invalid_app_user" });
    }
    await expect(client.registerLink({ appUser: "a".repeat(128) })).resolves.toBeTruthy();
    expect(posted).toHaveLength(1);
  });

  it("refuses a response without the link URL or the code, or with a link URL elsewhere", async () => {
    for (const extra of [{ link_consume_url: undefined }, { display_code: undefined }, { link_consume_url: "https://evil.example/consume-link/x" }]) {
      const { client } = await clientFor({ register: registered(extra) });
      await expect(client.registerLink({ appUser: "staff-01" })).rejects.toMatchObject({ code: "invalid_register_response" });
    }
  });
});

describe("return-confirmed linking", () => {
  const code = "A".repeat(43);
  const callback = `https://app.example/settings/clavis?request_id=${REQUEST}&return_code=${code}`;

  it("registers return confirmation and saves the mode without returning a display code", async () => {
    const { client, posted } = await clientFor({ register: registered({ display_code: undefined }) });
    const result = await client.registerLink({
      appUser: "staff-01",
      confirm: "return",
      returnUrl: "https://app.example/settings/clavis",
    });
    const claims = decodeJwt((JSON.parse(posted[0]!) as { registration: string }).registration);
    expect(claims).toMatchObject({ link_confirm: "return", return_url: "https://app.example/settings/clavis" });
    expect(result).not.toHaveProperty("displayCode");
    expect(result.pending).toMatchObject({ confirm: "return", requestId: REQUEST, appUser: "staff-01" });
  });

  it("requires a return URL and a response that matches the selected confirmation", async () => {
    const { client } = await clientFor();
    await expect(client.registerLink({ appUser: "staff-01", confirm: "return", returnUrl: "" }))
      .rejects.toMatchObject({ code: "invalid_link_confirmation" });
    await expect(client.registerLink({ appUser: "staff-01", confirm: "return", returnUrl: "https://app.example/linked" }))
      .rejects.toMatchObject({ code: "invalid_register_response" });
  });

  it("uses the return code and still verifies the receipt", async () => {
    const { client, reportedReturnCodes } = await clientFor({ status: completed });
    const verify = vi.spyOn(client.verifier, "verifyReceipt").mockResolvedValue(linkReceipt());
    await expect(client.completeLink(pendingFor({ confirm: "return" }), {
      returned: new URL(callback),
      appUser: "staff-01",
    })).resolves.toMatchObject({ iss: API_ORIGIN, sub: PAIRWISE, appUser: "staff-01" });
    expect(reportedReturnCodes).toEqual([code]);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("checks the signed-in user, request and unique return code before contacting Clavis", async () => {
    const { client, net } = await clientFor({ status: completed });
    const pending = pendingFor({ confirm: "return" });
    await expect(client.completeLink(pending, { returned: callback, appUser: "staff-02" }))
      .rejects.toMatchObject({ code: "link_mismatch" });
    await expect(client.completeLink(pending, { returned: callback, appUser: "" }))
      .rejects.toMatchObject({ code: "invalid_app_user" });
    for (const returned of [callback.replace(REQUEST, "other"), callback + "&request_id=other"]) {
      await expect(client.completeLink(pending, { returned, appUser: "staff-01" }))
        .rejects.toMatchObject({ code: "link_mismatch" });
    }
    for (const returned of [undefined, "invalid URL", callback.replace(code, "short"), callback + "&return_code=second"]) {
      await expect(client.completeLink(pending, { returned, appUser: "staff-01" }))
        .rejects.toMatchObject({ code: "invalid_callback" });
    }
    expect(net.calls).toEqual([]);
  });
});

describe("completeLink", () => {
  it("is link_pending until the user signs", async () => {
    let state: unknown = { state: "pending", request_id: REQUEST };
    const { client } = await clientFor({ status: () => state });
    await expect(client.completeLink(pendingFor())).rejects.toMatchObject({ code: "link_pending" });
    state = { state: "intent_issued", request_id: REQUEST, intent_type: "generic_sign" };
    await expect(client.completeLink(pendingFor())).rejects.toMatchObject({ code: "link_pending" });
  });

  it("has the verifier check the receipt, and refuses one that is not a link", async () => {
    // 見本の受領は本物の app.sign@1。照合器は通すが、連携の文型ではない
    const { client } = await clientFor({ status: completed });
    await expect(client.completeLink(pendingFor())).rejects.toMatchObject({ code: "link_mismatch" });
    // 別の依頼の status
    const other = await clientFor({ status: () => ({ ...completed(), request_id: "another-request" }) });
    await expect(other.client.completeLink(pendingFor())).rejects.toMatchObject({ code: "status_request_mismatch" });
  });

  it("returns iss, sub and appUser from a link receipt that binds what was asked", async () => {
    const { client } = await clientFor({ status: completed });
    const verify = vi.spyOn(client.verifier, "verifyReceipt").mockResolvedValue(linkReceipt());
    await expect(client.completeLink(pendingFor())).resolves.toEqual({
      iss: API_ORIGIN,
      sub: PAIRWISE,
      appUser: "staff-01",
      linkedAt: 1791747759,
      receipt: "{\"type\":\"receipt.app@1\"}",
      anchor: expect.objectContaining({ state: "anchored" }),
    });
    expect(verify).toHaveBeenCalledWith(APP_RECEIPT, { expect: { aud: `request:${REQUEST}` } });
  });

  it("refuses a link receipt for another user, nonce, issuer, request or app", async () => {
    const { client } = await clientFor({ status: completed });
    const verify = vi.spyOn(client.verifier, "verifyReceipt");
    for (const statement of [{ app_user: "staff-02" }, { nonce: "0e6f1d0a-3c8e-4b7a-9d2f-1e5b8c4a7d90" }, { iss: "https://api.other.test" }]) {
      verify.mockResolvedValueOnce(linkReceipt(statement));
      await expect(client.completeLink(pendingFor())).rejects.toMatchObject({ code: "link_mismatch" });
    }
    for (const statement of [{ request: "another-request" }, { app: "another-app" }]) {
      verify.mockResolvedValueOnce(linkReceipt(statement));
      await expect(client.completeLink(pendingFor())).rejects.toMatchObject({ code: "status_request_mismatch" });
    }
  });

  it("refuses a pending value registerLink did not make", async () => {
    const { client, net } = await clientFor({ status: completed });
    for (const bad of [null, {}, pendingFor({ nonce: "not-a-uuid" }), pendingFor({ pollSecret: "" })]) {
      await expect(client.completeLink(bad as PendingLink)).rejects.toMatchObject({ code: "invalid_status_args" });
    }
    expect(net.calls).toEqual([]);
  });
});
