import { decodeJwt, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "./canonical-json.js";
import { digestOf } from "./digest.js";
import { AppClientError, createAppClient } from "./index.js";
import { sha256, toHex, utf8 } from "./ledger/bytes.js";
import { mandateCallDigest, normalizeMandateLabel, prepareMandateTerms, type MandateTerms } from "./mandate.js";
import { API_ORIGIN, MASTER, fakeNet, vector, vectorVerifiers } from "./test-fixtures.js";

const NOW = 1_800_000_000;
// 照合器のリポジトリの見本: 付与の App 向け受領、範囲、実行の記録二つ、終わりの記録（すべて文字列）
const H = vector("mandate_history").input as { grant: string; terms: string; uses: string[]; close: string };
const GRANT = JSON.parse(H.grant) as { statement: { request: string; app: string; mandate: string }; envelope: { signer: string; iat: number } };
const TERMS = JSON.parse(H.terms) as MandateTerms;
const MANDATE_ID = GRANT.statement.mandate;
const APP_ID = GRANT.statement.app;
const SUB = GRANT.envelope.signer;
const USE2 = H.uses[1]!;
const USE2_REQUEST = (JSON.parse(USE2) as { request: Record<string, string | number> }).request;
const VERIFIERS = await vectorVerifiers();

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.alg = "EdDSA";
  return JSON.stringify(jwk);
}

type Call = { url: string; method: string; headers: Headers; body: string | undefined };

async function clientWith(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const net = fakeNet((url, init) => {
    const call: Call = { url: url.toString(), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    return respond(call);
  });
  const client = createAppClient({
    apiOrigin: API_ORIGIN,
    appId: APP_ID,
    operatePrivateJwk: await operateJwk(),
    trustRoot: MASTER,
    verifiers: VERIFIERS,
    fetchImpl: net.fetchImpl,
  });
  return { client, calls };
}

const INPUT_TERMS = {
  operations: [{ name: "invoice.pay", label: " 請求書の  支払い " }],
  uses: 5,
  not_after: Math.floor(Date.now() / 1000) + 7 * 86400,
};

const useInput = {
  operation: USE2_REQUEST.operation as string,
  call: USE2_REQUEST.call as string,
  amount: USE2_REQUEST.amount as number,
  agent: USE2_REQUEST.agent as string,
  use: USE2_REQUEST.use as string,
};

describe("prepareMandateTerms (same rules as Clavis)", () => {
  const base = { operations: [{ name: "invoice.pay", label: "請求書の支払い" }], uses: 3, not_after: NOW + 3600 };

  it("normalizes names and sorts by identifier", () => {
    const r = prepareMandateTerms(
      {
        ...base,
        operations: [
          { name: "z.op", label: "  最後の\u3000操作 " },
          { name: "a.op", label: "最初" },
        ],
        targets: [
          { id: "vendor_b", label: "B" },
          { id: "vendor_a", label: "A" },
        ],
      },
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      terms: {
        type: "mandate.terms@1",
        operations: [
          { name: "a.op", label: "最初" },
          { name: "z.op", label: "最後の 操作" },
        ],
        uses: 3,
        not_after: NOW + 3600,
        targets: [
          { id: "vendor_a", label: "A" },
          { id: "vendor_b", label: "B" },
        ],
      },
    });
  });

  it("refuses names that reorder or hide text, duplicates and out-of-range lifetimes", () => {
    for (const bad of ["a\u202eb", "注文 1234\u200f-5678", "a\u2066b", "a\u0007", "\ud800"]) {
      expect(normalizeMandateLabel(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(prepareMandateTerms({ ...base, operations: [{ name: "x", label: "a\u202eb" }] }, NOW)).toEqual({ ok: false, reason: "label" });
    expect(
      prepareMandateTerms({ ...base, operations: [{ name: "x", label: "X" }, { name: "x", label: "Y" }] }, NOW),
    ).toEqual({ ok: false, reason: "duplicate" });
    expect(prepareMandateTerms({ ...base, not_after: NOW + 299 }, NOW)).toEqual({ ok: false, reason: "lifetime" });
    expect(prepareMandateTerms({ ...base, not_after: NOW + 30 * 86400 + 1 }, NOW)).toEqual({ ok: false, reason: "lifetime" });
    expect(prepareMandateTerms({ ...base, uses: 1001 }, NOW)).toEqual({ ok: false, reason: "shape" });
    expect(prepareMandateTerms({ ...base, extra: 1 }, NOW)).toEqual({ ok: false, reason: "shape" });
  });
});

describe("createAppClient: mandates", () => {
  it("registers a mandate and keeps the terms the user will sign", async () => {
    const { client, calls } = await clientWith(async (call) => {
      const claims = decodeJwt(JSON.parse(call.body!).registration as string) as Record<string, unknown>;
      const terms = (claims.payload as { terms: unknown }).terms;
      return Response.json({
        payload: {
          request_id: "eu1.rid",
          poll_secret: "secret",
          consume_url: `${API_ORIGIN}/app/intent-requests/consume-mandate/eu1.rid`,
          mandate: { id: MANDATE_ID, terms },
        },
      });
    });
    const out = await client.registerMandate({ terms: INPUT_TERMS, allowedSub: SUB });
    expect(out.mandate).toEqual({
      id: MANDATE_ID,
      terms: { type: "mandate.terms@1", ...INPUT_TERMS, operations: [{ name: "invoice.pay", label: "請求書の 支払い" }] },
    });
    const claims = decodeJwt(JSON.parse(calls[0]!.body!).registration as string);
    expect(claims).toMatchObject({ intent_type: "mandate", allowed_sub: SUB, app_id: APP_ID });
    expect(Object.keys(claims.payload as object)).toEqual(["terms"]);
  });

  it("refuses terms Clavis changed, and bad terms before sending", async () => {
    const { client, calls } = await clientWith(() =>
      Response.json({
        payload: {
          request_id: "eu1.rid",
          poll_secret: "secret",
          consume_url: `${API_ORIGIN}/app/intent-requests/consume-mandate/eu1.rid`,
          mandate: { id: MANDATE_ID, terms: { type: "mandate.terms@1", ...INPUT_TERMS, uses: 50, operations: [{ name: "invoice.pay", label: "請求書の 支払い" }] } },
        },
      }),
    );
    await expect(client.registerMandate({ terms: INPUT_TERMS, allowedSub: SUB })).rejects.toMatchObject({ code: "mandate_terms_mismatch" });
    await expect(client.registerMandate({ terms: { ...INPUT_TERMS, uses: 0 }, allowedSub: SUB })).rejects.toMatchObject({ code: "invalid_mandate_terms" });
    await expect(client.registerMandate({ terms: INPUT_TERMS, allowedSub: "" })).rejects.toMatchObject({ code: "invalid_allowed_sub" });
    expect(calls).toHaveLength(1);
  });

  it("reads the completed grant only when it binds the requested mandate and terms", async () => {
    const request = GRANT.statement.request;
    const { client } = await clientWith(() =>
      Response.json({ payload: { state: "completed", request_id: request, intent_type: "mandate", receipt: H.grant, mandate: { id: MANDATE_ID, terms: TERMS } } }),
    );
    const done = await client.getMandateStatus(request, "secret", { id: MANDATE_ID, terms: TERMS });
    expect(done).toMatchObject({ state: "completed", mandate: MANDATE_ID, sub: SUB, grantedAt: GRANT.envelope.iat, receipt: H.grant });
    await expect(client.getMandateStatus(request, "secret", { id: MANDATE_ID, terms: { ...TERMS, uses: TERMS.uses + 1 } })).rejects.toMatchObject({
      code: "mandate_mismatch",
    });
    // 署名の完了として読もうとしても通らない
    await expect(client.getStatus(request, "secret", "A".repeat(43))).rejects.toMatchObject({ code: "invalid_status" });
  });

  it("has Collatio check the whole history the store returns, as the strings it returned", async () => {
    const history = {
      view: {
        mandate: MANDATE_ID,
        app_id: APP_ID,
        subject: SUB,
        terms: TERMS,
        grant: await digestOf((JSON.parse(H.grant) as { envelope: unknown }).envelope),
        opened_at: GRANT.envelope.iat,
        state: "closed",
        totals: { uses: 2, amount: 20000 },
        close: H.close,
      },
      grant_receipt: H.grant,
      uses: H.uses.map((record, i) => ({ record, ledger: { log_id: "eu1.org", index: i + 2, receipt: "r" } })),
      ledger: { grant: { log_id: "eu1.org", index: 1, receipt: "r" }, close: null },
    };
    const { client, calls } = await clientWith(() => Response.json(history));
    const out = await client.getMandateHistory(MANDATE_ID);
    expect(out.facts.uses.map((u) => u.seq)).toEqual([1, 2]);
    expect(out.uses.map((u) => u.record)).toEqual(H.uses);
    expect(out.view).toMatchObject({ id: MANDATE_ID, state: "closed", close: { record: H.close, facts: { reason: "revoked_by_holder" } } });
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/app/mandates/${MANDATE_ID}?history=1`);
    // 実行の記録が一つ抜けた一式は返さない
    const second = await clientWith(() => Response.json({ ...history, uses: history.uses.slice(1) }));
    await expect(second.client.getMandateHistory(MANDATE_ID)).rejects.toMatchObject({ code: "invalid_mandate_record" });
    // 累計が記録と合わない状態も返さない
    const third = await clientWith(() => Response.json({ ...history, view: { ...history.view, totals: { uses: 2, amount: 1 } } }));
    await expect(third.client.getMandateHistory(MANDATE_ID)).rejects.toMatchObject({ code: "invalid_mandate_record" });
  });

  it("sends a canonical use request with a JWT bound to its bytes, and has Collatio check the record", async () => {
    const { client, calls } = await clientWith(() => Response.json({ record: USE2, replayed: true, close: H.close }));
    const out = await client.useMandate(MANDATE_ID, useInput);
    expect(out).toMatchObject({ replayed: true, record: USE2, use: { seq: 2, totals: { uses: 2, amount: 20000 } }, close: { facts: { reason: "revoked_by_holder" } } });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${API_ORIGIN}/app/mandates/${MANDATE_ID}/uses`);
    expect(call.body).toBe(canonicalStringify(USE2_REQUEST));
    const jwt = call.headers.get("authorization")!.replace(/^ClavisApp /, "");
    expect(decodeJwt(jwt)).toMatchObject({
      aud: "clavis-ledger",
      htm: "POST",
      htu: `/app/mandates/${MANDATE_ID}/uses`,
      body_sha256: toHex(await sha256(utf8(call.body!))),
    });
  });

  it("refuses a record Collatio refuses, a record of another request, and a fresh record without this request's JWT", async () => {
    const forged = USE2.replace(/"sig":"[^"]+"/, `"sig":"${"A".repeat(86)}"`);
    const a = await clientWith(() => Response.json({ record: forged, replayed: true }));
    await expect(a.client.useMandate(MANDATE_ID, useInput)).rejects.toMatchObject({ code: "invalid_mandate_record", verifierReason: "mandate_attest_signature" });
    const b = await clientWith(() => Response.json({ record: USE2, replayed: true }));
    await expect(b.client.useMandate(MANDATE_ID, { ...useInput, amount: 1 })).rejects.toMatchObject({ code: "invalid_mandate_record" });
    const c = await clientWith(() => Response.json({ record: USE2, replayed: false }));
    await expect(c.client.useMandate(MANDATE_ID, useInput)).rejects.toMatchObject({ code: "invalid_mandate_record" });
    // 記録はオブジェクトでは受けない（文字列のまま照合器に渡す）
    const d = await clientWith(() => Response.json({ record: JSON.parse(USE2), replayed: true }));
    await expect(d.client.useMandate(MANDATE_ID, useInput)).rejects.toMatchObject({ code: "invalid_mandate_record" });
  });

  it("reports the violated limits when Clavis refuses a use", async () => {
    const { client } = await clientWith(() =>
      Response.json({ error: "OUTSIDE_MANDATE", message: "the request is outside the mandate", violations: ["amount_total", "uses"] }, { status: 403 }),
    );
    const err = await client
      .useMandate(MANDATE_ID, { operation: "invoice.pay", call: await mandateCallDigest({ invoice: "inv_1" }), amount: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppClientError);
    expect(err).toMatchObject({ code: "mandate_outside", status: 403, violations: ["amount_total", "uses"] });
    const closed = await clientWith(() => Response.json({ error: "MANDATE_CLOSED", reason: "revoked_by_holder" }, { status: 409 }));
    await expect(closed.client.useMandate(MANDATE_ID, { operation: "invoice.pay", call: await mandateCallDigest({ invoice: "inv_1" }) })).rejects.toMatchObject({
      code: "mandate_closed",
    });
  });

  it("checks shapes before calling Clavis", async () => {
    const { client, calls } = await clientWith(() => Response.json({}));
    await expect(client.useMandate("not-a-uuid", { operation: "x", call: `sha256:${"A".repeat(43)}` })).rejects.toMatchObject({ code: "invalid_mandate_id" });
    await expect(client.useMandate(MANDATE_ID, { operation: "x", call: "not-a-digest" })).rejects.toMatchObject({ code: "invalid_mandate_use" });
    await expect(client.listMandates({ sub: "bad sub" })).rejects.toMatchObject({ code: "invalid_allowed_sub" });
    expect(calls).toHaveLength(0);
  });
});
