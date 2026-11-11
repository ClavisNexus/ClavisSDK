import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { bytesToBase64Url, base64UrlToBytes } from "./base64url.js";
import { canonicalStringify } from "./canonical-json.js";
import { AppClientError, createAppClient, digestOf, type AppClient, type CompleteSignInput, type MandateHistoryFacts, type MandateView, type SignInput } from "./index.js";
import { sha256, toHex, utf8 } from "./ledger/bytes.js";
import { ENTITY_JWS_TYP, normalizeHtu, signEntityRequest, type EntityRequestKey } from "./entity-request.js";
import { API_ORIGIN, MASTER, TRUST_ORIGIN, fakeNet, jsonResponse, vectorVerifiers } from "./test-fixtures.js";

const API = API_ORIGIN;
const APP_ID = "app-1";
const ENTITY = await digestOf("entity");
const KEY_ID = await digestOf("signing-key");
const RECEIPT2 = '{"type":"receipt@2","statement":{"type":"note"}}';
const VERIFIERS = await vectorVerifiers();

type NoBehalf<T> = "onBehalf" extends keyof T ? "onBehalf" : "expectedOnBehalf" extends keyof T ? "expectedOnBehalf" : never;
type _publicHasNoOnBehalf = [
  NoBehalf<AppClient>,
  NoBehalf<MandateView>,
  NoBehalf<MandateHistoryFacts>,
  NoBehalf<MandateHistoryFacts["grant"]>,
  NoBehalf<SignInput>,
  NoBehalf<CompleteSignInput>,
] extends [never, never, never, never, never, never]
  ? true
  : never;
const _publicHasNoOnBehalf: _publicHasNoOnBehalf = true;

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.alg = "EdDSA";
  return JSON.stringify(jwk);
}

async function requestJwk(alg: "EdDSA" | "ES256"): Promise<string> {
  const { privateKey } = await generateKeyPair(alg, { extractable: true });
  return JSON.stringify(await exportJWK(privateKey));
}

describe("createAppClient", () => {
  it("needs the Master public JWK as trustRoot, and refuses the 2.x pin option", async () => {
    const operate = await operateJwk();
    const base = { apiOrigin: API, appId: APP_ID, operatePrivateJwk: operate };
    expect(() => createAppClient({ ...base, trustRoot: "{}" })).toThrow(expect.objectContaining({ code: "invalid_trust_root" }));
    expect(() => createAppClient({ ...base, masterPublicJwkJson: JSON.stringify(MASTER) } as unknown as Parameters<typeof createAppClient>[0])).toThrow(
      expect.objectContaining({ code: "removed_option" }),
    );
    expect(() => createAppClient({ ...base, apiOrigin: "https://rp.test", trustRoot: MASTER })).toThrow(
      expect.objectContaining({ code: "invalid_trust_origin" }),
    );
    expect(() => createAppClient({ ...base, apiOrigin: "https://rp.test", trustRoot: MASTER, trustOrigins: [TRUST_ORIGIN] })).not.toThrow();
    expect(_publicHasNoOnBehalf).toBe(true);
  });
});

describe("relay sign", () => {
  it("sends ClavisEntity and clavis-entity+jws, then completes without userHandle and returns receipt@2", async () => {
    const requestPrivateJwk = await requestJwk("EdDSA");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    let signBody = "";
    let signAuth = "";
    let completeBody = "";
    const net = fakeNet((url, init) => {
      if (url.pathname === "/relay/v1/sign") {
        signBody = String(init?.body);
        signAuth = new Headers(init?.headers).get("authorization") ?? "";
        return jsonResponse({
          envelope: { suite: "webauthn.relayed@1", statement: KEY_ID },
          dimension: { type: "dimension@2", name: "relay" },
          challenge: "Y2hhbGxlbmdl",
        });
      }
      if (url.pathname === "/relay/v1/sign/complete") {
        completeBody = String(init?.body);
        return jsonResponse({ receipt: RECEIPT2 });
      }
      return null;
    });
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: await operateJwk(),
      entityId: ENTITY,
      requestPrivateJwk,
      trustRoot: MASTER,
      verifiers: VERIFIERS,
      fetchImpl: net.fetchImpl,
    });
    const started = await client.sign({
      statement: { type: "note", digest: "abc" },
      signer: "holder-1",
      key: KEY_ID,
      linkLookup: null,
    });
    expect(started.challenge).toBe("Y2hhbGxlbmdl");
    expect(signAuth.startsWith("ClavisEntity ")).toBe(true);
    const jws = signAuth.slice("ClavisEntity ".length);
    expect(decodeProtectedHeader(jws)).toEqual({
      alg: "EdDSA",
      typ: ENTITY_JWS_TYP,
      kid: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/),
    });
    const claims = decodeJwt(jws);
    expect(Object.keys(claims).sort()).toEqual(["body_sha256", "entity", "exp", "htm", "htu", "iat", "jti"]);
    expect(claims.entity).toBe(ENTITY);
    expect(claims.htm).toBe("POST");
    expect(claims.htu).toBe(`${API}/relay/v1/sign`);
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(claims.body_sha256).toBe(toHex(await sha256(utf8(signBody))));
    expect(JSON.parse(signBody)).toEqual({
      key: KEY_ID,
      link_lookup: null,
      signer: "holder-1",
      statement: { digest: "abc", type: "note" },
      suite: "webauthn.relayed@1",
    });
    expect(signBody).toBe(canonicalStringify(JSON.parse(signBody)));

    const done = await client.completeSign({
      envelope: started.envelope,
      proof: {
        authenticator_data: "YQ",
        client_data_json: "Yg",
        signature: "Yw",
        userHandle: "hidden",
        rawId: "hidden",
      } as CompleteSignInput["proof"],
    });
    expect(done).toEqual({ receipt: RECEIPT2 });
    expect(done.receipt).toContain("receipt@2");
    const complete = JSON.parse(completeBody) as { envelope: string; proof: Record<string, string> };
    expect(complete.envelope).toBe(await digestOf(started.envelope));
    expect(complete.proof).toEqual({ authenticator_data: "YQ", client_data_json: "Yg", signature: "Yw" });
    expect(completeBody).not.toContain("userHandle");
    expect(completeBody).not.toContain("rawId");
    await expect(client.verifier.verifyReceipt(done.receipt)).rejects.toMatchObject({
      code: "receipt_invalid",
      verifierReason: "receipt_type",
    });
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    log.mockRestore();
    info.mockRestore();
    debug.mockRestore();
  });

  it("signs an ES256 request key and omits body_sha256 when there is no body", async () => {
    const requestPrivateJwk = await requestJwk("ES256");
    let alg = "";
    const net = fakeNet((url, init) => {
      if (url.pathname === "/relay/v1/sign") {
        alg = String(decodeProtectedHeader((new Headers(init?.headers).get("authorization") ?? "").split(" ")[1] ?? "").alg);
        return jsonResponse({
          envelope: { suite: "webauthn.relayed@1" },
          dimension: { type: "dimension@2" },
          challenge: "YQ",
        });
      }
      return null;
    });
    const client = createAppClient({
      apiOrigin: "https://API.Example:443",
      appId: APP_ID,
      operatePrivateJwk: await operateJwk(),
      entityId: ENTITY,
      requestPrivateJwk,
      trustRoot: MASTER,
      trustOrigins: [TRUST_ORIGIN],
      fetchImpl: net.fetchImpl,
    });
    await client.sign({ statement: { type: "note" }, signer: "holder-1", key: KEY_ID });
    expect(alg).toBe("ES256");

    const key: EntityRequestKey = {
      alg: "EdDSA",
      kid: KEY_ID,
      sign: async () => new Uint8Array(64),
    };
    const compact = await signEntityRequest({
      key,
      entity: ENTITY,
      method: "get",
      url: "HTTPS://API.Example:443/relay/v1/read",
      body: new Uint8Array(),
    });
    const claims = decodeJwt(compact);
    expect(claims.htm).toBe("GET");
    expect(claims.htu).toBe(normalizeHtu("HTTPS://API.Example:443/relay/v1/read"));
    expect(claims.htu).toBe("https://api.example/relay/v1/read");
    expect(claims).not.toHaveProperty("body_sha256");
    const jti = claims.jti as string;
    expect(bytesToBase64Url(base64UrlToBytes(jti))).toBe(jti);
  });

  it("refuses a receipt that is not receipt@2", async () => {
    const net = fakeNet((url) => {
      if (url.pathname === "/relay/v1/sign/complete") return jsonResponse({ receipt: '{"type":"receipt@1"}' });
      return null;
    });
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: await operateJwk(),
      entityId: ENTITY,
      requestPrivateJwk: await requestJwk("EdDSA"),
      trustRoot: MASTER,
      fetchImpl: net.fetchImpl,
    });
    await expect(
      client.completeSign({
        envelope: KEY_ID,
        proof: { authenticator_data: "YQ", client_data_json: "Yg", signature: "Yw" },
      }),
    ).rejects.toMatchObject({ code: "invalid_sign_response" });
    expect(AppClientError).toBeTypeOf("function");
  });
});

describe("public exports", () => {
  it("exposes the client, the verifier, the request builders and the error type", async () => {
    const sdk = await import("./index.js");
    expect(Object.keys(sdk).sort()).toEqual([
      "AppClientError",
      "MANDATE_CLOSE_REASONS",
      "MANDATE_GRANT",
      "MANDATE_VIOLATIONS",
      "attachLedgerOpening",
      "computeLedgerCommitment",
      "computeLedgerSlot",
      "createAppClient",
      "createLedgerOpening",
      "createVerifier",
      "digestOf",
      "ledgerAssetVersionSlotLabel",
      "mandateCallDigest",
      "mandateUseRequestBody",
      "normalizeMandateLabel",
      "parseMandateTerms",
      "prepareMandateTerms",
      "signLedgerAppRequest",
    ]);
    expect(Object.keys(sdk).join(" ")).not.toMatch(/onBehalf|on_behalf|OnBehalf/);
    expect(AppClientError).toBeTypeOf("function");
  });
});
