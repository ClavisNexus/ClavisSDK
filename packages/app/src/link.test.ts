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
async function clientFor(answer: { register?: unknown; status?: () => unknown; returnCode?: string } = {}) {
  const posted: string[] = [];
  /** status を読んだときの `X-Intent-Return-Code`（無ければ null） */
  const returnCodes: Array<string | null> = [];
  const net = fakeNet((url, init) => {
    if (url.pathname === "/app/intent-requests/register") {
      posted.push(String(init?.body));
      return jsonResponse(answer.register ?? registered());
    }
    if (url.pathname.startsWith("/app/intent-requests/status/")) {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Intent-Poll-Secret")).toBe("poll-secret");
      returnCodes.push(headers.get("X-Intent-Return-Code"));
      if (answer.returnCode !== undefined && headers.get("X-Intent-Return-Code") !== answer.returnCode) {
        return jsonResponse({ error: headers.get("X-Intent-Return-Code") ? "RETURN_CODE_MISMATCH" : "RETURN_CODE_REQUIRED", message: "m" }, 403);
      }
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
  return { client, posted, net, returnCodes };
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
    expect(claims).not.toHaveProperty("link_confirm");
    expect(result).toEqual({
      confirm: "code",
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

const RETURN_CODE = "Rc".repeat(21) + "x";
const returnUrl = "https://app.example/clavis/linked";
const returned = (extra: Record<string, string> = {}) => {
  const u = new URL(returnUrl);
  u.searchParams.set("request_id", REQUEST);
  u.searchParams.set("return_code", RETURN_CODE);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
};

describe("a link confirmed by the return", () => {
  it("registers link_confirm with the return URL and keeps no display code", async () => {
    const { client, posted } = await clientFor({ register: registered({ display_code: undefined }) });
    const result = await client.registerLink({ appUser: "staff-01", confirm: "return", returnUrl });
    const claims = decodeJwt((JSON.parse(posted[0]!) as { registration: string }).registration);
    expect(claims.link_confirm).toBe("return");
    expect(claims.return_url).toBe(returnUrl);
    expect(result).toEqual({
      confirm: "return",
      requestId: REQUEST,
      consumeUrl: `${API_ORIGIN}/app/intent-requests/consume-link/${REQUEST}`,
      pending: expect.objectContaining({ requestId: REQUEST, appUser: "staff-01", confirm: "return" }),
    });
    expect(result).not.toHaveProperty("displayCode");
  });

  it("needs a return URL, and refuses a response that still carries a display code", async () => {
    const { client, posted } = await clientFor();
    await expect(client.registerLink({ appUser: "staff-01", confirm: "return", returnUrl: " " })).rejects.toMatchObject({
      code: "invalid_link_confirm",
    });
    await expect(client.registerLink({ appUser: "staff-01", confirm: "redirect" } as never)).rejects.toMatchObject({ code: "invalid_link_confirm" });
    expect(posted).toHaveLength(0);
    await expect(client.registerLink({ appUser: "staff-01", confirm: "return", returnUrl })).rejects.toMatchObject({
      code: "invalid_register_response",
    });
  });

  it("completes only with this link's return and the user who started it, sending the return code", async () => {
    const { client, net, returnCodes } = await clientFor({ status: completed, returnCode: RETURN_CODE });
    vi.spyOn(client.verifier, "verifyReceipt").mockResolvedValue(linkReceipt());
    const pending = pendingFor({ confirm: "return" });
    const refused = [
      [{}, "link_user_mismatch"],
      [{ appUser: "staff-01" }, "link_return_mismatch"],
      [{ appUser: "staff-02", returned: returned() }, "link_user_mismatch"],
      [{ appUser: "staff-01", returned: returned({ request_id: "eu1.another" }) }, "link_return_mismatch"],
      [{ appUser: "staff-01", returned: returned({ return_code: "short" }) }, "link_return_mismatch"],
      [{ appUser: "staff-01", returned: returnUrl }, "link_return_mismatch"],
    ] as const;
    for (const [options, code] of refused) {
      await expect(client.completeLink(pending, options)).rejects.toMatchObject({ code });
    }
    // 照らす前に断ったものは、status を読まない
    expect(net.calls).toEqual([]);
    for (const form of [returned(), new URL(returned()), new URL(returned()).searchParams, new URL(returned()).search]) {
      await expect(client.completeLink(pending, { appUser: " staff-01 ", returned: form })).resolves.toMatchObject({
        sub: PAIRWISE,
        appUser: "staff-01",
      });
    }
    expect(returnCodes.every((c) => c === RETURN_CODE)).toBe(true);
  });

  it("reads a wrong return code from Clavis as link_return_mismatch", async () => {
    const { client } = await clientFor({ status: completed, returnCode: "Zz".repeat(21) + "z" });
    await expect(client.completeLink(pendingFor({ confirm: "return" }), { appUser: "staff-01", returned: returned() })).rejects.toMatchObject({
      code: "link_return_mismatch",
      apiError: "RETURN_CODE_MISMATCH",
    });
  });

  it("checks the user on a code link when it is given, and reads status without a return code", async () => {
    const { client, returnCodes } = await clientFor({ status: completed });
    vi.spyOn(client.verifier, "verifyReceipt").mockResolvedValue(linkReceipt());
    await expect(client.completeLink(pendingFor(), { appUser: "staff-02" })).rejects.toMatchObject({ code: "link_user_mismatch" });
    await expect(client.completeLink(pendingFor(), { appUser: "staff-01" })).resolves.toMatchObject({ sub: PAIRWISE });
    await expect(client.completeLink(pendingFor())).resolves.toMatchObject({ sub: PAIRWISE });
    expect(returnCodes).toEqual([null, null]);
  });

  it("refuses a pending value whose confirm it does not know", async () => {
    const { client } = await clientFor({ status: completed });
    await expect(client.completeLink(pendingFor({ confirm: "code" as "return" }))).rejects.toMatchObject({ code: "invalid_status_args" });
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
