import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { AppClientError, createAppClient } from "./index.js";
import { API_ORIGIN, APP_RECEIPT, APP_STATEMENT, MASTER, PAIRWISE, TRUST_ORIGIN, fakeNet, jsonResponse, vectorVerifiers } from "./test-fixtures.js";

const API = API_ORIGIN;
const APP_ID = APP_STATEMENT.app;
const REQUEST = APP_STATEMENT.request;
const DIGEST = APP_STATEMENT.digest;
const SIGNED_AT = (JSON.parse(APP_RECEIPT) as { envelope: { iat: number } }).envelope.iat;
const VERIFIERS = await vectorVerifiers();

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.alg = "EdDSA";
  return JSON.stringify(jwk);
}

const completed = (extra: Record<string, unknown> = {}) => ({
  state: "completed",
  request_id: REQUEST,
  intent_type: "generic_sign",
  receipt: APP_RECEIPT,
  ...extra,
});

/** status の応答を返す App の API と、照合面（見本の信頼の文書）。`respond` は status の本文（`{ payload }` の中身） */
async function clientFor(respond: (n: number) => unknown, over: { appId?: string; status?: number } = {}) {
  let n = 0;
  const net = fakeNet((url, init) => {
    if (url.pathname.startsWith("/app/intent-requests/status/")) {
      expect(new Headers(init?.headers).get("X-Intent-Poll-Secret")).toBe("poll-secret");
      n += 1;
      const body = respond(n);
      return body instanceof Response ? body : jsonResponse({ payload: body }, over.status ?? 200);
    }
    return null;
  });
  const client = createAppClient({
    apiOrigin: API,
    appId: over.appId ?? APP_ID,
    operatePrivateJwk: await operateJwk(),
    trustRoot: MASTER,
    verifiers: VERIFIERS,
    fetchImpl: net.fetchImpl,
  });
  return { client, net, reads: () => n };
}

describe("createAppClient", () => {
  it("needs the Master public JWK as trustRoot, and refuses the 2.x pin option", async () => {
    const operate = await operateJwk();
    const base = { apiOrigin: API, appId: APP_ID, operatePrivateJwk: operate };
    expect(() => createAppClient({ ...base, trustRoot: "{}" })).toThrow(expect.objectContaining({ code: "invalid_trust_root" }));
    expect(() => createAppClient({ ...base, masterPublicJwkJson: JSON.stringify(MASTER) } as unknown as Parameters<typeof createAppClient>[0])).toThrow(
      expect.objectContaining({ code: "removed_option" }),
    );
    // api.<apex> でない Origin には照合面を渡す
    expect(() => createAppClient({ ...base, apiOrigin: "https://rp.test", trustRoot: MASTER })).toThrow(
      expect.objectContaining({ code: "invalid_trust_origin" }),
    );
    expect(() => createAppClient({ ...base, apiOrigin: "https://rp.test", trustRoot: MASTER, trustOrigins: [TRUST_ORIGIN] })).not.toThrow();
  });
});

describe("registerGenericSign", () => {
  it("posts an EdDSA registration JWT that embeds the supplied digest and nothing about what to sign", async () => {
    const operate = await operateJwk();
    let captured = "";
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        captured = String(init?.body);
        return jsonResponse({
          payload: {
            request_id: "11111111-1111-1111-1111-111111111111",
            poll_secret: "deadbeef",
            consume_url: API + "/consume",
            display_code: "AB12",
          },
        });
      },
    });
    const result = await client.registerGenericSign({
      messageDigest: DIGEST,
      returnUrl: "https://app.example/done",
      displayHint: "ROLE-07",
    });
    expect(result.pollSecret).toBe("deadbeef");
    expect(result.displayCode).toBe("AB12");
    const body = JSON.parse(captured) as { registration: string };
    expect(Object.keys(body)).toEqual(["registration"]);
    expect(decodeProtectedHeader(body.registration).alg).toBe("EdDSA");
    const claims = decodeJwt(body.registration);
    expect(claims.iss).toBe(`app:${APP_ID}`);
    expect(claims.aud).toBe("app-intent-registration");
    expect(claims.payload).toEqual({ message_digest: DIGEST, display_hint: "ROLE-07" });
    expect(claims.exp).toBe((claims.iat as number) + 120);
  });

  it("sets the request lifetime from ttlSeconds and refuses one Clavis would not take", async () => {
    const operate = await operateJwk();
    let captured = "";
    let posts = 0;
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async (_input, init) => {
        posts += 1;
        captured = String(init?.body);
        return jsonResponse({
          payload: { request_id: "11111111-1111-1111-1111-111111111111", poll_secret: "s", consume_url: API + "/c" },
        });
      },
    });
    await client.registerGenericSign({ messageDigest: DIGEST, returnUrl: "https://app.example/done", ttlSeconds: 600 });
    const claims = decodeJwt((JSON.parse(captured) as { registration: string }).registration);
    expect(claims.exp).toBe((claims.iat as number) + 600);
    for (const ttlSeconds of [59, 901, 300.5]) {
      await expect(
        client.registerGenericSign({ messageDigest: DIGEST, returnUrl: "https://app.example/done", ttlSeconds }),
      ).rejects.toMatchObject({ code: "invalid_ttl" });
    }
    expect(posts).toBe(1);
  });

  it("rejects a digest that is not a SHA-256 Base64URL before posting", async () => {
    const operate = await operateJwk();
    let posted = false;
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async () => {
        posted = true;
        return jsonResponse({});
      },
    });
    for (const messageDigest of ["", "short", `${DIGEST}A`, "A".repeat(42) + "+"]) {
      await expect(client.registerGenericSign({ messageDigest, returnUrl: "https://app.example/done" })).rejects.toMatchObject({
        code: "invalid_message_digest",
      });
    }
    expect(posted).toBe(false);
  });

  it("carries the app's languages as the ui_locales claim, in order", async () => {
    const operate = await operateJwk();
    let captured = "";
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async (_input, init) => {
        captured = String(init?.body);
        return jsonResponse({
          payload: { request_id: "11111111-1111-1111-1111-111111111111", poll_secret: "p", consume_url: API + "/c" },
        });
      },
    });
    await client.registerGenericSign({
      messageDigest: DIGEST,
      returnUrl: "https://app.example/done",
      uiLocales: ["en_GB", "en"],
    });
    const claims = decodeJwt((JSON.parse(captured) as { registration: string }).registration);
    expect(claims.ui_locales).toEqual(["en-GB", "en"]);

    const swapped = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async () =>
        jsonResponse({
          payload: {
            request_id: "11111111-1111-1111-1111-111111111111",
            poll_secret: "p",
            consume_url: "https://evil.example/consume",
          },
        }),
    });
    await expect(swapped.registerGenericSign({ messageDigest: DIGEST, returnUrl: "https://app.example/done" })).rejects.toMatchObject({
      code: "invalid_register_response",
    });

    await client.registerGenericSign({ messageDigest: DIGEST, returnUrl: "https://app.example/done" });
    expect(decodeJwt((JSON.parse(captured) as { registration: string }).registration)).not.toHaveProperty("ui_locales");
  });

  it("asks on behalf of an organization with the domain in the form Clavis reads, and rejects a malformed domain before posting", async () => {
    const operate = await operateJwk();
    let captured = "";
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async (_input, init) => {
        captured = String(init?.body);
        return jsonResponse({
          payload: { request_id: "11111111-1111-1111-1111-111111111111", poll_secret: "p", consume_url: API + "/c" },
        });
      },
    });
    const registered = await client.registerGenericSign({ messageDigest: DIGEST, onBehalf: { domain: " Supplier.CO.JP. " } });
    expect(registered.onBehalf).toEqual({ domain: "supplier.co.jp" });
    expect(decodeJwt((JSON.parse(captured) as { registration: string }).registration).on_behalf).toEqual({ domain: "supplier.co.jp" });

    captured = "";
    for (const domain of ["localhost", "under_score.example", "-bad.example", ""]) {
      await expect(client.registerGenericSign({ messageDigest: DIGEST, onBehalf: { domain } })).rejects.toMatchObject({
        code: "invalid_on_behalf",
      });
    }
    expect(captured).toBe("");
  });

  it("rejects ui locales that are not language tags before posting", async () => {
    const operate = await operateJwk();
    let posted = false;
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async () => {
        posted = true;
        return jsonResponse({});
      },
    });
    for (const uiLocales of [[], ["ja jp"], ["日本語"], Array.from({ length: 17 }, () => "en")]) {
      await expect(
        client.registerGenericSign({ messageDigest: DIGEST, returnUrl: "https://app.example/done", uiLocales }),
      ).rejects.toMatchObject({ code: "invalid_ui_locales" });
    }
    expect(posted).toBe(false);
  });

  it("surfaces the API error code", async () => {
    const operate = await operateJwk();
    const client = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: operate,
      trustRoot: MASTER,
      fetchImpl: async () =>
        jsonResponse({ error: "RETURN_URL_NOT_ALLOWED", message: "return_url_not_allowed", trace_id: "trace-1" }, 403),
    });
    await expect(
      client.registerGenericSign({ messageDigest: DIGEST, returnUrl: "https://evil.example/done" }),
    ).rejects.toMatchObject({
      code: "register_failed",
      status: 403,
      apiError: "RETURN_URL_NOT_ALLOWED",
      traceId: "trace-1",
    });
  });
});

describe("getStatus", () => {
  it("reads the completion from the app receipt, as Collatio verified it", async () => {
    const { client, net } = await clientFor(() => completed({ sub: "claimed-by-response", signed_at: 1 }));
    const status = await client.getStatus(REQUEST, "poll-secret", DIGEST);
    expect(status).toMatchObject({
      state: "completed",
      intentType: "generic_sign",
      statementType: "app.sign@1",
      sub: PAIRWISE,
      messageDigest: DIGEST,
      signedAt: SIGNED_AT,
      receipt: APP_RECEIPT,
      anchor: { state: "anchored", log: "first-party.0", index: 42 },
    });
    expect(net.calls).toContain(`GET ${API}/app/intent-requests/status/${encodeURIComponent(REQUEST)}`);
  });

  it("rejects an edited receipt, a receipt for another request, and another app's receipt", async () => {
    const edited = await clientFor(() => completed({ receipt: APP_RECEIPT.replace(DIGEST, "B".repeat(43)) }));
    await expect(edited.client.getStatus(REQUEST, "poll-secret", DIGEST)).rejects.toMatchObject({ code: "receipt_invalid" });
    const other = await clientFor(() => completed({ request_id: "eu1.another" }));
    await expect(other.client.getStatus("eu1.another", "poll-secret", DIGEST)).rejects.toMatchObject({
      code: "receipt_invalid",
      verifierReason: "expect_aud",
    });
    const foreign = await clientFor(() => completed(), { appId: "11111111-2222-4333-8444-555555555555" });
    await expect(foreign.client.getStatus(REQUEST, "poll-secret", DIGEST)).rejects.toMatchObject({ code: "status_request_mismatch" });
    const swapped = await clientFor(() => completed({ request_id: "eu1.another" }));
    await expect(swapped.client.getStatus(REQUEST, "poll-secret", DIGEST)).rejects.toMatchObject({ code: "status_request_mismatch" });
  });

  it("checks the digest the caller stored and whether it asked on behalf of an organization", async () => {
    const { client } = await clientFor(() => completed());
    await expect(client.getStatus(REQUEST, "poll-secret", "C".repeat(43))).rejects.toMatchObject({ code: "digest_mismatch" });
    // 組織の名で求めたのに、組織の名でない受領が来た
    await expect(client.getStatus(REQUEST, "poll-secret", DIGEST, { expectedOnBehalf: { domain: "supplier.co.jp" } })).rejects.toMatchObject({
      code: "on_behalf_mismatch",
    });
  });

  it("fails closed on an issued status without a type and a completion without a receipt", async () => {
    const issued = await clientFor(() => ({ state: "intent_issued", request_id: REQUEST, intent_type: "" }));
    await expect(issued.client.getStatus(REQUEST, "poll-secret", DIGEST)).rejects.toMatchObject({ code: "invalid_status" });
    const bare = await clientFor(() => completed({ receipt: undefined }));
    await expect(bare.client.getStatus(REQUEST, "poll-secret", DIGEST)).rejects.toMatchObject({ code: "invalid_status" });
    // 受領は文字列で運ぶ（オブジェクトは読まない）
    const object = await clientFor(() => completed({ receipt: JSON.parse(APP_RECEIPT) }));
    await expect(object.client.getStatus(REQUEST, "poll-secret", DIGEST)).rejects.toMatchObject({ code: "invalid_status" });
  });
});

describe("readWebhookPing", () => {
  it("returns the ping fields and drops anything else, without verifying anything", async () => {
    const { client } = await clientFor(() => completed());
    const ping = client.readWebhookPing({
      event: "intent_request.completed",
      request_id: REQUEST,
      intent_type: "generic_sign",
      state: "completed",
      receipt: { forged: true },
    });
    expect(ping).toEqual({ event: "intent_request.completed", requestId: REQUEST, intentType: "generic_sign", state: "completed" });
    expect(() => client.readWebhookPing({ event: "x", request_id: REQUEST, intent_type: "generic_sign", state: "pending" })).toThrow(
      expect.objectContaining({ code: "invalid_webhook_ping" }),
    );
  });
});

describe("waitForCompletion", () => {
  it("polls until the receipt arrives", async () => {
    const { client, reads } = await clientFor((n) => (n === 1 ? { state: "pending", request_id: REQUEST } : completed()));
    const result = await client.waitForCompletion(REQUEST, "poll-secret", {
      intervalMs: 1,
      timeoutMs: 5_000,
      expectedMessageDigest: DIGEST,
      sleep: async () => undefined,
    });
    expect(result.messageDigest).toBe(DIGEST);
    expect(reads()).toBe(2);
  });

  it("keeps waiting through a rate-limited read, spacing the next reads out", async () => {
    const pauses: number[] = [];
    const { client } = await clientFor((n) => (n <= 2 ? jsonResponse({ error: "RATE_LIMITED", message: "too many requests" }, 429) : completed()));
    const result = await client.waitForCompletion(REQUEST, "poll-secret", {
      intervalMs: 100,
      timeoutMs: 5_000,
      expectedMessageDigest: DIGEST,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result.state).toBe("completed");
    expect(pauses).toEqual([200, 400]);
  });

  it("still fails on a status error other than the read limit, and on a network failure", async () => {
    const notFound = await clientFor(() => jsonResponse({ error: "NOT_FOUND", message: "unknown request_id or poll secret expired" }, 404));
    await expect(
      notFound.client.waitForCompletion(REQUEST, "poll-secret", { expectedMessageDigest: DIGEST, sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: "status_failed", status: 404, apiError: "NOT_FOUND" });
    const offline = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: await operateJwk(),
      trustRoot: MASTER,
      fetchImpl: async () => {
        throw new TypeError("socket hang up");
      },
    });
    await expect(offline.getStatus(REQUEST, "secret", DIGEST)).rejects.toMatchObject({ code: "network_error" });
  });

  it("aborts a hung status read when the wait times out", async () => {
    const hung = createAppClient({
      apiOrigin: API,
      appId: APP_ID,
      operatePrivateJwk: await operateJwk(),
      trustRoot: MASTER,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    });
    await expect(hung.waitForCompletion(REQUEST, "secret", { expectedMessageDigest: DIGEST, timeoutMs: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

describe("public exports", () => {
  it("exposes the client, the verifier, the request builders and the error type", async () => {
    const sdk = await import("./index.js");
    expect(Object.keys(sdk).sort()).toEqual([
      "APP_SIGN_ON_BEHALF",
      "AppClientError",
      "MANDATE_CLOSE_REASONS",
      "MANDATE_GRANT",
      "MANDATE_GRANT_ON_BEHALF",
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
      "normalizeOnBehalfDomain",
      "parseMandateTerms",
      "prepareMandateTerms",
      "readOnBehalf",
      "signLedgerAppRequest",
    ]);
    expect(AppClientError).toBeTypeOf("function");
  });
});
