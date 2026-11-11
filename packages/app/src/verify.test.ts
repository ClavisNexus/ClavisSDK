import { describe, expect, it } from "vitest";
import { AppClientError } from "./errors.js";
import {
  API_ORIGIN,
  APP_RECEIPT,
  APP_STATEMENT,
  MASTER,
  PAIRWISE,
  TRUST_ORIGIN,
  fakeNet,
  vector,
  vectorVerifiers,
} from "./test-fixtures.js";
import { createVerifier } from "./verify.js";

async function verifierFor(net: ReturnType<typeof fakeNet>, trustRoot: JsonWebKey | string = MASTER) {
  return createVerifier({ trustRoot, apiOrigin: API_ORIGIN, trustOrigins: [TRUST_ORIGIN], verifiers: await vectorVerifiers(), fetchImpl: net.fetchImpl });
}

describe("verifyReceipt", () => {
  it("reads the facts from Collatio and checks the anchor on the trust surface", async () => {
    const net = fakeNet();
    const v = await verifierFor(net);
    const r = await v.verifyReceipt(APP_RECEIPT, { expect: { aud: `request:${APP_STATEMENT.request}` } });
    expect(r.receipt).toBe(APP_RECEIPT);
    expect(r).toMatchObject({ type: "receipt.app@1", statement: APP_STATEMENT, catalogStale: false });
    expect(r.envelope.signer).toBe(PAIRWISE);
    expect(r.anchor).toMatchObject({ log: "first-party.0", index: 42, state: "anchored", size: 43 });
    // 照合面から信頼の文書・登録表・チェックポイントを、API から包含証明を取った
    expect(net.calls).toEqual(
      expect.arrayContaining([
        `GET ${TRUST_ORIGIN}/v1/jwks.json`,
        `GET ${TRUST_ORIGIN}/v1/catalog.json`,
        `GET ${TRUST_ORIGIN}/v1/logs/first-party.0/checkpoint`,
        `GET ${API_ORIGIN}/archive/ledger/first-party.0/proof?index=42&size=43`,
      ]),
    );
  });

  it("answers unanchored while the leaf is past the published checkpoint, or the surface is down", async () => {
    const smaller = vector("bundle: a first-party shard").input.evidence as string;
    const pending = await (await verifierFor(fakeNet(undefined, { checkpoint: JSON.parse(smaller).checkpoint }))).verifyReceipt(APP_RECEIPT);
    expect(pending.anchor).toMatchObject({ state: "unanchored", reason: "pending" });
    const down = await (await verifierFor(fakeNet(undefined, { checkpoint: null }))).verifyReceipt(APP_RECEIPT);
    expect(down.anchor).toMatchObject({ state: "unanchored", reason: "unavailable" });
    const skipped = await (await verifierFor(fakeNet())).verifyReceipt(APP_RECEIPT, { anchor: "skip" });
    expect(skipped.anchor).toMatchObject({ state: "unanchored", reason: "skipped" });
  });

  it("refuses a proof that does not lead to the published root", async () => {
    const proof = vector("inclusion: the app receipt's anchor in that checkpoint").input.proof as string[];
    const wrong = [...proof].reverse();
    await expect((await verifierFor(fakeNet(undefined, { inclusion: wrong }))).verifyReceipt(APP_RECEIPT)).rejects.toMatchObject({
      code: "anchor_invalid",
    });
  });

  it("refuses a receipt Collatio refuses, with Collatio's reason", async () => {
    const v = await verifierFor(fakeNet());
    const edited = APP_RECEIPT.replace(APP_STATEMENT.digest, "A".repeat(43));
    const e = await v.verifyReceipt(edited).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppClientError);
    expect(e).toMatchObject({ code: "receipt_invalid", verifierReason: "statement_digest" });
    // 重複したキーは、JSON.parse なら後勝ちで通るが、文字列のまま渡すので照合器が断る
    const dup = APP_RECEIPT.replace('"type":"receipt.app@1"', '"type":"receipt.app@1","type":"receipt.app@1"');
    await expect(v.verifyReceipt(dup)).rejects.toMatchObject({ verifierReason: "json_duplicate_key" });
    await expect(v.verifyReceipt(APP_RECEIPT, { expect: { aud: "request:eu1.other" } })).rejects.toMatchObject({ verifierReason: "expect_aud" });
    await expect(v.verifyReceipt('{"type":"receipt@2","statement":{"type":"note"}}')).rejects.toMatchObject({
      code: "receipt_invalid",
      verifierReason: "receipt_type",
    });
  });

  it("trusts only the Master pin, and refuses the 2.x option", async () => {
    const other = { ...MASTER, x: MASTER.y, y: MASTER.x };
    await expect((await verifierFor(fakeNet(), other)).verifyReceipt(APP_RECEIPT)).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(() =>
      createVerifier({ trustRoot: MASTER, apiOrigin: API_ORIGIN, masterPublicJwkJson: "{}" } as unknown as Parameters<typeof createVerifier>[0]),
    ).toThrow(expect.objectContaining({ code: "removed_option" }));
    expect(() => createVerifier({ trustRoot: { ...MASTER, d: "x" } as JsonWebKey, apiOrigin: API_ORIGIN })).toThrow(
      expect.objectContaining({ code: "invalid_trust_root" }),
    );
    // 照合面の既定は api. を trust. に替えたもの
    const net = fakeNet();
    await createVerifier({ trustRoot: MASTER, apiOrigin: "https://api.clavis.test", fetchImpl: net.fetchImpl, verifiers: await vectorVerifiers() }).verifyReceipt(
      APP_RECEIPT,
      { anchor: "skip" },
    );
    expect(net.calls[0]).toBe(`GET ${TRUST_ORIGIN}/v1/jwks.json`);
  });
});

describe("trust", () => {
  it("checks that trustRoot is the instance's Master", async () => {
    const facts = await (await verifierFor(fakeNet())).trust();
    expect(facts).toMatchObject({ instance: "clavis.nexus", sealer: "clavis-sealer" });
    expect(facts.keys.some((k) => k.slot === "sign-receipt")).toBe(true);
    const other = { ...MASTER, x: MASTER.y, y: MASTER.x };
    await expect((await verifierFor(fakeNet(), other)).trust()).rejects.toMatchObject({ code: "invalid_trust_root" });
  });
});

describe("verifyMandateRecord / verifyMandateHistory", () => {
  it("checks one record and the whole history with Collatio", async () => {
    const v = await verifierFor(fakeNet());
    const use = vector("mandate_record: a use");
    const facts = await v.verifyMandateRecord(use.input.record as string, { app: use.input.app as string });
    expect(facts).toMatchObject({ type: "mandate.use@1", seq: 2, operation: "book" });
    await expect(v.verifyMandateRecord(vector("mandate_record: a use for another app").input.record as string, { app: use.input.app as string })).rejects.toMatchObject({
      code: "invalid_mandate_record",
      verifierReason: "mandate_app_jwt_app",
    });
    const h = vector("mandate_history").input;
    const history = await v.verifyMandateHistory({ grant: h.grant as string, terms: h.terms as string, uses: h.uses as string[], close: h.close as string });
    expect(history.grant).toMatchObject({ type: "mandate.grant@1", mandate: expect.any(String) });
    expect(history.grant).not.toHaveProperty("onBehalf");
    expect(history.uses).toHaveLength(2);
    expect(history.close).toMatchObject({ reason: "revoked_by_holder", uses: 2 });
  });
});

describe("verifyLedgerBundle", () => {
  it("checks a first-party bundle with its opening", async () => {
    const v = await verifierFor(fakeNet());
    const facts = await v.verifyLedgerBundle(vector("bundle: a first-party shard").input.evidence as string);
    expect(facts).toMatchObject({ log: "first-party.0", opening: true });
  });
});
