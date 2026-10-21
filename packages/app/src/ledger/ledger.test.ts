import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { AppClientError, createAppClient, computeLedgerCommitment, createLedgerOpening } from "../index.js";
import { API_ORIGIN, MASTER, fakeNet, vectorLedgerSigner, vectorVerifiers } from "../test-fixtures.js";
import { fromBase64, fromHex, toBase64 } from "./bytes.js";
import { ledgerLeafHashHex, parseLedgerLeaf, type LedgerLeaf } from "./leaf.js";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const ORG_LOG = "eu1.6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";
const ORIGIN = `clavis.nexus/ledger/${ORG_LOG}`;
const VERIFIERS = await vectorVerifiers();
const SIGNER = await vectorLedgerSigner();

async function operateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  return JSON.stringify(await exportJWK(privateKey));
}

/** 台帳の受領証（葉を `index` に積んだ）と、葉一つのチェックポイント */
async function notesFor(leaf: LedgerLeaf, index = 0) {
  const leafHash = toBase64(fromHex(await ledgerLeafHashHex(leaf)));
  return {
    receipt: await SIGNER.sign(`clavis.ledger.receipt/v1\n${ORIGIN}\n${index}\n${leafHash}\n`),
    checkpoint: await SIGNER.sign(`${ORIGIN}\n1\n${leafHash}\ntime 1791750060\n`),
  };
}

async function appWith(api: Parameters<typeof fakeNet>[0]) {
  return createAppClient({
    apiOrigin: API_ORIGIN,
    appId: APP_ID,
    operatePrivateJwk: await operateJwk(),
    trustRoot: MASTER,
    verifiers: VERIFIERS,
    fetchImpl: fakeNet(api).fetchImpl,
  });
}

describe("ledger handoff", () => {
  it("creates a fresh salt and does not send the record", async () => {
    const a = createLedgerOpening({ asset: "a-1" });
    const b = createLedgerOpening({ asset: "a-1" });
    expect(a.salt).not.toBe(b.salt);
    expect(await computeLedgerCommitment(a)).not.toBe(await computeLedgerCommitment(b));
  });

  it("returns an opening-bearing handoff, posts only the leaf, and has Collatio check the ledger receipt", async () => {
    let posted = "";
    let auth = "";
    let index = 0;
    const app = await appWith(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      const raw = init?.body;
      posted = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "");
      auth = new Headers(init?.headers).get("authorization") ?? "";
      const leaf = parseLedgerLeaf((JSON.parse(posted) as { leaf: unknown }).leaf)!;
      const { receipt } = await notesFor(leaf, index);
      return Response.json({ log_id: ORG_LOG, status: "created", index: 0, leaf_hash: await ledgerLeafHashHex(leaf), receipt }, { status: 201 });
    });
    const handoff = await app.commitLedger({ record: { asset: "a-1", to: "u2" }, slotKey: new Uint8Array(32).fill(7), assetId: "a-1", version: 1 });
    expect(handoff.opening.record).toEqual({ asset: "a-1", to: "u2" });
    expect(handoff.logId).toBe(ORG_LOG);
    expect(posted).not.toContain("u2");
    expect(posted).not.toContain(handoff.opening.salt);
    const body = JSON.parse(posted) as { leaf: { v: number; c: string; slot: string } };
    expect(body.leaf).toMatchObject({ v: 1, c: handoff.leaf.c });
    expect(body.leaf.slot).toMatch(/^[0-9a-f]{64}$/);
    const claims = decodeJwt(auth.replace(/^ClavisApp /, ""));
    expect(claims).toMatchObject({ aud: "clavis-ledger", htu: "/archive/ledger/v1/entries", htm: "POST" });
    // 受領証が別の位置を言えば受け取らない
    index = 3;
    await expect(app.commitLedger({ record: { n: 1 } })).rejects.toMatchObject({ code: "invalid_ledger_handoff" });
  });

  it("adds the opening to the checkpoint bundle and has Collatio check the whole bundle", async () => {
    const opening = createLedgerOpening({ n: 1 });
    const leaf: LedgerLeaf = { v: 1, c: await computeLedgerCommitment(opening) };
    const notes = await notesFor(leaf);
    const app = await appWith(() =>
      Response.json({
        anchor_status: "pending",
        bundle: { type: "ledger.bundle@1", log: ORG_LOG, leaf, index: 0, receipt: notes.receipt, checkpoint: notes.checkpoint, inclusion: [] },
      }),
    );
    const handoff = { version: 1 as const, opening, leaf, logId: ORG_LOG, index: 0, leafHash: await ledgerLeafHashHex(leaf), receipt: notes.receipt };
    const evidence = await app.finishLedgerHandoff(handoff);
    expect(evidence.facts).toMatchObject({ log: ORG_LOG, index: 0, opening: true, committedBy: 1791750060, anchor: null });
    expect(JSON.parse(evidence.bundle)).toMatchObject({ type: "ledger.bundle@1", opening });
    // 別の開示を持つ受け渡し記録は、照合器が断る
    const other = { ...handoff, opening: createLedgerOpening({ n: 2 }) };
    await expect(app.finishLedgerHandoff(other)).rejects.toMatchObject({ code: "ledger_bundle_invalid", verifierReason: "bundle_opening" });
  });

  it("folds timestamp encodings that differ only in unused base64 bits", () => {
    const forms = ["aGVsbG8gd29ybGQ=", "aGVsbG8gd29ybGR=", "aGVsbG8gd29ybGS=", "aGVsbG8gd29ybGT="];
    expect(new Set(forms.map((s) => toBase64(fromBase64(s)))).size).toBe(1);
  });

  it("maps slot conflicts", async () => {
    const app = await appWith(() => Response.json({ error: "SLOT_TAKEN", message: "taken", trace_id: "t1" }, { status: 409 }));
    await expect(app.commitLedger({ record: { n: 1 } })).rejects.toMatchObject({
      code: "ledger_commit_failed",
      apiError: "SLOT_TAKEN",
      traceId: "t1",
    } satisfies Partial<AppClientError>);
  });
});
