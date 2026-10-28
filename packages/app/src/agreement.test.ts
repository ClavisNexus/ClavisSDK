import { decodeJwt, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { agreementActionAllowed, agreementStatusFrom, checkAgreementInput, parseAgreementState } from "./agreement.js";
import { AppClientError, createAppClient } from "./index.js";
import { API_ORIGIN, APP_RECEIPT, APP_STATEMENT, MASTER, fakeNet, jsonResponse, vectorVerifiers } from "./test-fixtures.js";
import type { VerifiedReceipt } from "./verify.js";

const APP_ID = APP_STATEMENT.app;
const REQUEST = APP_STATEMENT.request;
const VERIFIERS = await vectorVerifiers();

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.alg = "EdDSA";
  return JSON.stringify(jwk);
}

/** 照合器が読んだ形の App 向けの受領（同意の文型） */
function agreeReceipt(over: Record<string, unknown> = {}): VerifiedReceipt {
  return {
    type: "receipt.app@1",
    receipt: "<receipt>",
    statement: { type: "lex.agree@1", request: REQUEST, org: "eu1.org", app: APP_ID, action: "grant", use_case: "tos", shown: "sha256:x", ...over },
    envelope: { signer: "pairwise-1", iat: 1_800_000_000 },
    anchor: { state: "anchored" },
  } as unknown as VerifiedReceipt;
}

describe("agreements: what a completion may be", () => {
  it("answers a grant with a grant, a reconsent on changed terms or a decline, and a withdrawal only with a withdrawal", () => {
    expect(["grant", "reconsent", "deny"].every((a) => agreementActionAllowed("grant", a))).toBe(true);
    expect(agreementActionAllowed("grant", "withdraw")).toBe(false);
    expect(agreementActionAllowed("reconsent", "grant")).toBe(false);
    expect(agreementActionAllowed("withdraw", "withdraw")).toBe(true);
    expect(agreementActionAllowed("withdraw", "deny")).toBe(false);
  });

  it("reads a signed grant from its receipt, and a decline or a withdrawal from Clavis's answer alone", () => {
    const expected = { useCase: "tos", ceremony: "grant" } as const;
    expect(agreementStatusFrom({ action: "grant", decision_id: "dec-1" }, agreeReceipt(), expected)).toMatchObject({
      state: "completed",
      action: "grant",
      decisionId: "dec-1",
      sub: "pairwise-1",
      signedAt: 1_800_000_000,
    });
    expect(agreementStatusFrom({ action: "deny", decision_id: "dec-2" }, null, expected)).toEqual({
      state: "completed",
      intentType: "agreement",
      action: "deny",
      decisionId: "dec-2",
      useCase: "tos",
    });
    const fail = (payload: Record<string, unknown>, verified: VerifiedReceipt | null, ceremony = "grant" as const) => {
      try {
        agreementStatusFrom(payload, verified, { useCase: "tos", ceremony });
        return null;
      } catch (e) {
        return (e as AppClientError).code;
      }
    };
    expect(fail({ action: "grant", decision_id: "dec-1" }, null)).toBe("invalid_status");
    expect(fail({ action: "deny", decision_id: "dec-1" }, agreeReceipt())).toBe("invalid_status");
    expect(fail({ action: "grant", decision_id: "dec-1" }, agreeReceipt({ use_case: "marketing" }))).toBe("agreement_mismatch");
    expect(fail({ action: "grant", decision_id: "dec-1" }, agreeReceipt({ type: "app.sign@1" }))).toBe("agreement_mismatch");
    expect(fail({ action: "reconsent", decision_id: "dec-1" }, agreeReceipt())).toBe("agreement_mismatch");
    expect(fail({ action: "withdraw", decision_id: "dec-1" }, null)).toBe("agreement_mismatch");
    expect(fail({ action: "grant" }, agreeReceipt())).toBe("invalid_status");
  });

  it("checks what an app asks for before anything is sent", () => {
    expect(checkAgreementInput({ useCase: "tos" })).toEqual({ useCase: "tos", ceremony: "grant" });
    const code = (input: Parameters<typeof checkAgreementInput>[0]) => {
      try {
        checkAgreementInput(input);
        return null;
      } catch (e) {
        return (e as AppClientError).code;
      }
    };
    expect(code({ useCase: "account_register" })).toBe("invalid_agreement");
    expect(code({ useCase: "tos", ceremony: "deny" })).toBe("invalid_agreement");
    expect(code({ useCase: "tos", ageMethod: "app_kyc" })).toBe("invalid_agreement");
    expect(code({ useCase: "tos", ageBand: "18_plus", ageMethod: "app_kyc", ageAssertionRequired: true })).toBe("invalid_agreement");
    expect(code({ useCase: "tos", ageBand: "18_plus", ageMethod: "app_kyc" })).toBeNull();
  });

  it("reads the state Clavis answers with, and refuses anything else", () => {
    expect(parseAgreementState({ state: "none" })).toEqual({ state: "none" });
    expect(parseAgreementState({ state: "open", decision_id: "dec-1", since: "2026-10-01T00:00:00.000Z", reconsent_required: true })).toEqual({
      state: "open",
      decisionId: "dec-1",
      since: "2026-10-01T00:00:00.000Z",
      reconsentRequired: true,
    });
    expect(() => parseAgreementState({ state: "open" })).toThrow(expect.objectContaining({ code: "invalid_agreement_state" }));
  });
});

describe("agreements through the client", () => {
  async function client(api: Parameters<typeof fakeNet>[0]) {
    const net = fakeNet(api);
    return {
      net,
      client: createAppClient({
        apiOrigin: API_ORIGIN,
        appId: APP_ID,
        operatePrivateJwk: await operateJwk(),
        trustRoot: MASTER,
        verifiers: VERIFIERS,
        fetchImpl: net.fetchImpl,
      }),
    };
  }

  it("registers an agreement with what Clavis needs to build the screen, and nothing about what is shown", async () => {
    let registration = "";
    const { client: c } = await client((url, init) => {
      if (url.pathname !== "/app/intent-requests/register") return null;
      registration = (JSON.parse(String(init?.body)) as { registration: string }).registration;
      return jsonResponse({ payload: { request_id: REQUEST, poll_secret: "poll-secret", consume_url: `${API_ORIGIN}/consume/${REQUEST}` } });
    });
    const res = await c.registerAgreement({ useCase: "marketing", ceremony: "withdraw", allowedSub: "pairwise-1", uiLocales: ["ja"] });
    expect(res).toMatchObject({ requestId: REQUEST, agreement: { useCase: "marketing", ceremony: "withdraw" } });
    const claims = decodeJwt(registration);
    expect(claims).toMatchObject({
      intent_type: "agreement",
      payload: { use_case: "marketing", ceremony: "withdraw" },
      allowed_sub: "pairwise-1",
      ui_locales: ["ja"],
    });
    await expect(c.registerAgreement({ useCase: "nope" as "tos" })).rejects.toMatchObject({ code: "invalid_agreement" });
  });

  it("reads a decline without a receipt, and refuses a completion whose receipt is not an agreement", async () => {
    let body: Record<string, unknown> = { state: "completed", request_id: REQUEST, intent_type: "agreement", action: "deny", decision_id: "dec-9" };
    const { client: c } = await client((url) =>
      url.pathname.startsWith("/app/intent-requests/status/") ? jsonResponse({ payload: body }) : null,
    );
    expect(await c.getAgreementStatus(REQUEST, "poll-secret", { useCase: "tos", ceremony: "grant" })).toMatchObject({ action: "deny", decisionId: "dec-9" });
    // 照合器が通した App 向けの受領でも、同意の文型でなければ受けない
    body = { ...body, action: "grant", receipt: APP_RECEIPT };
    await expect(c.getAgreementStatus(REQUEST, "poll-secret", { useCase: "tos", ceremony: "grant" })).rejects.toMatchObject({ code: "agreement_mismatch" });
    body = { state: "pending", request_id: REQUEST };
    expect(await c.getAgreementStatus(REQUEST, "poll-secret", { useCase: "tos", ceremony: "grant" })).toEqual({ state: "pending" });
  });

  it("asks whether an agreement is in force with a request signed by the operate key, and gates on it", async () => {
    let state: unknown = { state: "open", decision_id: "dec-1", since: "2026-10-01T00:00:00.000Z", reconsent_required: false };
    let auth = "";
    let asked = "";
    const { client: c } = await client((url, init) => {
      if (url.pathname !== "/app/intent-requests/agreement/state") return null;
      auth = new Headers(init?.headers).get("authorization") ?? "";
      asked = url.search;
      return jsonResponse(state);
    });
    expect(await c.requireAgreement({ sub: "pairwise-1", useCase: "tos" })).toMatchObject({ decisionId: "dec-1" });
    expect(auth).toMatch(/^ClavisApp /);
    expect(asked).toBe("?subject=pairwise-1&use_case=tos");
    state = { state: "open", decision_id: "dec-1", since: "2026-10-01T00:00:00.000Z", reconsent_required: true };
    await expect(c.requireAgreement({ sub: "pairwise-1", useCase: "tos" })).rejects.toMatchObject({
      code: "agreement_required",
      agreement: "reconsent_required",
    });
    state = { state: "none" };
    await expect(c.requireAgreement({ sub: "pairwise-1", useCase: "tos" })).rejects.toMatchObject({ agreement: "none" });
    expect(await c.agreementState({ sub: "pairwise-1", useCase: "tos" })).toEqual({ state: "none" });
    await expect(c.agreementState({ sub: "", useCase: "tos" })).rejects.toBeInstanceOf(AppClientError);
  });
});
