/**
 * Checks receipts, delegation records and proof bundles with the Collatio verifier. The only trust
 * root is Clavis's Master public JWK (`trustRoot`); the aggregate JWKS and the catalog come from the
 * trust surface. Evidence goes to the verifier as the string that arrived, and what it holds is read
 * from the verifier's answer.
 *
 * For a receipt, it checks the ledger receipt, then uses the trust surface's checkpoint and the
 * inclusion proof to check that the leaf was appended to a first-party shard, and reports
 * `anchored` or `unanchored` in `anchor.state`. Pass `anchor: "skip"` to leave that out.
 */
import type { Answer } from "@clavis.nexus/collatio";
import { AppClientError } from "./errors.js";
import { parseTrustRoot, trustOriginFor, TrustSurface, type CollatioTrust } from "./trust.js";
import { VerifierHost, type VerifierModule } from "./verifier.js";

export type CreateVerifierOptions = {
  /** Clavis's Master public JWK (EC P-256, an object or a JSON string). It is the trust root */
  trustRoot: JsonWebKey | string;
  /** For example `https://api.clavis.nexus`: where the first-party shard's inclusion proof is read from */
  apiOrigin: string;
  /** Trust surface origins, tried in order. Omitted, it is `apiOrigin` with `api.` replaced by `trust.` */
  trustOrigins?: readonly string[];
  /** Verifiers to add. On a runtime that cannot compile WASM at runtime, only these are used */
  verifiers?: readonly VerifierModule[];
  fetchImpl?: typeof fetch;
};

/** The statement, `aud` and signer the verifier must find in the receipt. A receipt that differs is refused */
export type ReceiptExpect = { statement?: string; aud?: string; signer?: string };

/** Whether the leaf of the receipt's mark was appended to a first-party shard */
export type ReceiptAnchor = { log: string; index: number; origin: string; leafHash: string } & (
  | { state: "anchored"; size: number; time: number }
  | { state: "unanchored"; reason: "pending" | "unavailable" | "skipped" }
);

export type ReceiptEnvelope = { aud: string; signer: string; iat: number; dimension: string; statement: string } & Record<string, unknown>;

/** What the verifier read from the receipt, with the receipt string itself */
export type VerifiedReceipt = {
  /** The receipt as it arrived. Store it, and show it to the user or a third party */
  receipt: string;
  type: "receipt@1" | "receipt.app@1";
  statement: { type: string } & Record<string, unknown>;
  envelope: ReceiptEnvelope;
  dimension: { digest: string; name: string; verifier: string; registry: string; signer: string };
  accepted: { kid: string; at: number }[];
  anchor: ReceiptAnchor;
  /** The digest of the verifier that answered */
  verifier: string;
  /** The catalog is stale: 7 days since the last successful fetch from the trust surface, so a revocation may not have reached it */
  catalogStale: boolean;
};

export type VerifyReceiptOptions = {
  expect?: ReceiptExpect;
  /** To check an app receipt together with the holder's own proof, as a string */
  holderProof?: string;
  /** `check` by default. With `skip`, no inclusion proof is fetched: `anchor.state` is `unanchored`, reason `skipped` */
  anchor?: "check" | "skip";
};

export type MandateTotalsFacts = { uses: number; amount?: number };

/** What the verifier read from one delegation record (`mandate_record`) */
export type MandateRecordFacts =
  | {
      type: "mandate.use@1";
      digest: string;
      grant: string;
      mandate: string;
      seq: number;
      use: string;
      operation: string;
      /** The digest of the use request (`mandate.use_request@1`) */
      request: string;
      jwt: string;
      at: number;
      totals: MandateTotalsFacts;
    }
  | {
      type: "mandate.close@1";
      digest: string;
      grant: string;
      mandate: string;
      reason: string;
      uses: number;
      last: string | null;
      at: number;
    };

/** What the verifier read from the full set of records (`mandate_history`) */
export type MandateHistoryFacts = {
  grant: {
    type: "mandate.grant@1" | "mandate.grant.on_behalf@1";
    mandate: string;
    app: string;
    request: string;
    onBehalf: { org: string; domain: string } | null;
  };
  terms: Record<string, unknown>;
  uses: { seq: number; operation: string; at: number; totals: MandateTotalsFacts }[];
  close: { reason: string; at: number; uses: number } | null;
};

/** What the verifier read from the proof bundle (`bundle`) */
export type LedgerBundleFacts = {
  log: string;
  index: number;
  /** The time of the checkpoint that holds the leaf (Unix seconds) */
  committedBy: number;
  /** The opening matched the leaf's commitment */
  opening: boolean;
  /** The anchor, a timestamp proof. `tsa` is the count of tokens that chain to a root in the verifier's registry */
  anchor: { anchoredBy: number; tsa: number } | null;
};

/** What the verifier read when it checked that the trust documents chain to trustRoot, Clavis's Master public key */
export type TrustFacts = {
  /** The instance, for example `clavis.nexus` */
  instance: string;
  /** The kid of the key that signed the aggregate JWKS and the catalog */
  sealer: string;
  /** When the catalog was issued (Unix seconds) */
  issuedAt: number;
  keys: { kid: string; slot: string; alg: string }[];
  logs: { id: string; kid: string }[];
  catalogStale: boolean;
};

export type Verifier = {
  /** Check the trust surface's documents against `trustRoot`, for instance to see whether `trustRoot` is this instance's Master */
  trust: () => Promise<TrustFacts>;
  /** Check an app receipt (`receipt.app@1`) or a holder receipt (`receipt@1`) */
  verifyReceipt: (receipt: string, options?: VerifyReceiptOptions) => Promise<VerifiedReceipt>;
  /** Check one delegation record, a use or a close. With `app`, the use's app JWT is checked too */
  verifyMandateRecord: (record: string, options?: { app?: string }) => Promise<MandateRecordFacts>;
  /** Check the grant receipt, the terms, the chain of uses and the close */
  verifyMandateHistory: (input: { grant: string; terms: string; uses: readonly string[]; close?: string | null }) => Promise<MandateHistoryFacts>;
  /** Check a ledger proof bundle (`ledger.bundle@1`) */
  verifyLedgerBundle: (bundle: string) => Promise<LedgerBundleFacts>;
  /** Check a ledger receipt or checkpoint, each a signed note, and return what it says */
  verifyLedgerNote: (note: string) => Promise<LedgerNoteFacts>;
};

export type LedgerNoteFacts = {
  log: string;
  kid: string;
  body:
    | { kind: "receipt"; origin: string; index: number; leaf_hash: string }
    | { kind: "checkpoint"; origin: string; size: number; root: string; time: number };
};

/** Refusals a newer document may fix: a key, catalog or registry newer than the copy in hand */
const STALE_REASONS = new Set([
  "dimension_not_in_catalog",
  "registry_not_in_catalog",
  "accepted_key",
  "accepted_missing",
  "ledger_note_signer",
  "mandate_attest_signature",
]);

function refusal(code: "receipt_invalid" | "invalid_mandate_record" | "ledger_bundle_invalid" | "ledger_note_invalid", what: string, a: Answer): AppClientError {
  const reason = a.ok ? "answer_shape" : a.reason;
  return new AppClientError(code, `${what} was refused by the verifier (${reason})`, undefined, { verifierReason: reason });
}

function normalizeApiOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppClientError("invalid_api_origin", "apiOrigin must be an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname.toLowerCase());
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new AppClientError("invalid_api_origin", "apiOrigin must be https");
  }
  if (u.username || u.password) throw new AppClientError("invalid_api_origin", "apiOrigin must not contain credentials");
  return u.origin;
}

export function createVerifier(opts: CreateVerifierOptions): Verifier {
  if ("masterPublicJwkJson" in (opts as Record<string, unknown>)) {
    // The 2.x masterPublicJwkJson is a different key: never read it as trustRoot
    throw new AppClientError("removed_option", "masterPublicJwkJson was removed in 3.0; pass the Master public JWK as trustRoot");
  }
  const master = parseTrustRoot(opts.trustRoot);
  const apiOrigin = normalizeApiOrigin(opts.apiOrigin);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const origins = opts.trustOrigins?.length ? opts.trustOrigins.map(normalizeApiOrigin) : [trustOriginFor(apiOrigin)];
  if (origins.some((o) => o === null)) {
    throw new AppClientError("invalid_trust_origin", "pass trustOrigins (apiOrigin is not api.<apex>)");
  }
  const surface = new TrustSurface({ origins: origins as string[], master, fetchImpl });
  const host = new VerifierHost(opts.verifiers ?? [], (digest) => surface.verifierBytes(digest));
  let refreshedAt = 0;

  /** Call once with the trust documents attached. Missing registries are added, and a refusal on a stale document triggers one refetch */
  async function withTrust(make: (trust: CollatioTrust) => Record<string, unknown>): Promise<Answer> {
    let trust: CollatioTrust;
    try {
      trust = await surface.trust();
    } catch (e) {
      if (e instanceof AppClientError) throw e;
      throw new AppClientError("trust_unavailable", "the trust documents could not be read", undefined, { cause: e });
    }
    let answer = await host.call(make(trust));
    if (!answer.ok && answer.reason === "registry_missing") {
      const t = await host.call({ op: "trust", trust });
      if (t.ok) {
        trust = await surface.withRegistries(t.registries as string[]);
        answer = await host.call(make(trust));
      }
    }
    if (!answer.ok && STALE_REASONS.has(answer.reason) && Date.now() - refreshedAt > 60_000) {
      refreshedAt = Date.now();
      surface.invalidate();
      trust = await surface.trust();
      answer = await host.call(make(trust));
    }
    if (!answer.ok && answer.reason === "verifier_unavailable") {
      throw new AppClientError("verifier_unavailable", "no verifier this receipt names is available; pass it in `verifiers`");
    }
    return answer;
  }

  const now = () => Math.floor(Date.now() / 1000);

  /** Whether the leaf of the receipt's mark is included in the checkpoint served from the trust surface */
  async function anchorOf(place: { log: string; index: number; origin: string; leaf_hash: string }): Promise<ReceiptAnchor> {
    const base = { log: place.log, index: place.index, origin: place.origin, leafHash: place.leaf_hash };
    let note: string;
    try {
      note = await surface.checkpoint(place.log);
    } catch {
      return { ...base, state: "unanchored", reason: "unavailable" };
    }
    const cp = await withTrust((trust) => ({ op: "ledger_note", now: now(), trust, note }));
    const body = cp.ok ? (cp.body as { kind: string; origin: string; size: number; root: string; time: number }) : null;
    if (!cp.ok || cp.log !== place.log || body?.kind !== "checkpoint" || body.origin !== place.origin) {
      throw new AppClientError("anchor_invalid", `the published checkpoint of ${place.log} does not verify`);
    }
    if (place.index >= body.size) return { ...base, state: "unanchored", reason: "pending" };
    let inclusion: unknown;
    try {
      const q = new URLSearchParams({ index: String(place.index), size: String(body.size) });
      const res = await fetchImpl(`${apiOrigin}/archive/ledger/${encodeURIComponent(place.log)}/proof?${q.toString()}`, { redirect: "error" });
      if (!res.ok) return { ...base, state: "unanchored", reason: "unavailable" };
      inclusion = ((await res.json()) as { inclusion?: unknown }).inclusion;
    } catch {
      return { ...base, state: "unanchored", reason: "unavailable" };
    }
    if (!Array.isArray(inclusion) || inclusion.some((h) => typeof h !== "string")) {
      return { ...base, state: "unanchored", reason: "unavailable" };
    }
    const inc = await host.call({ op: "inclusion", index: place.index, size: body.size, leaf_hash: place.leaf_hash, proof: inclusion, root: body.root });
    if (!inc.ok) throw new AppClientError("anchor_invalid", `the leaf is not in ${place.log} at size ${body.size}`);
    return { ...base, state: "anchored", size: body.size, time: body.time };
  }

  async function verifyReceipt(receipt: string, options: VerifyReceiptOptions = {}): Promise<VerifiedReceipt> {
    if (typeof receipt !== "string" || receipt.length === 0) {
      throw new AppClientError("receipt_invalid", "a receipt is a string (the JSON as received)");
    }
    // Let the verifier decide the type: app or holder is told apart by the refusal reason (receipt_type)
    let answer = await withTrust((trust) => ({
      op: "app_receipt",
      now: now(),
      trust,
      evidence: receipt,
      ...(options.expect ? { expect: options.expect } : {}),
      ...(options.holderProof !== undefined ? { holder_proof: options.holderProof } : {}),
    }));
    if (!answer.ok && answer.reason === "receipt_type" && options.holderProof === undefined) {
      answer = await withTrust((trust) => ({ op: "receipt", now: now(), trust, evidence: receipt, ...(options.expect ? { expect: options.expect } : {}) }));
    }
    if (!answer.ok) throw refusal("receipt_invalid", "the receipt", answer);
    const a = answer as unknown as {
      type: VerifiedReceipt["type"];
      statement: VerifiedReceipt["statement"];
      envelope: ReceiptEnvelope;
      dimension: VerifiedReceipt["dimension"];
      accepted: VerifiedReceipt["accepted"];
      anchor: { log: string; index: number; origin: string; leaf_hash: string };
      verifier: string;
      catalog_stale?: true;
    };
    const anchor: ReceiptAnchor =
      options.anchor === "skip"
        ? { log: a.anchor.log, index: a.anchor.index, origin: a.anchor.origin, leafHash: a.anchor.leaf_hash, state: "unanchored", reason: "skipped" }
        : await anchorOf(a.anchor);
    return {
      receipt,
      type: a.type,
      statement: a.statement,
      envelope: a.envelope,
      dimension: a.dimension,
      accepted: a.accepted,
      anchor,
      verifier: a.verifier,
      catalogStale: surface.stale(),
    };
  }

  async function verifyMandateRecord(record: string, options: { app?: string } = {}): Promise<MandateRecordFacts> {
    if (typeof record !== "string") throw new AppClientError("invalid_mandate_record", "a record is a string (the JSON as received)");
    const answer = await withTrust((trust) => ({ op: "mandate_record", now: now(), trust, record, ...(options.app ? { app: options.app } : {}) }));
    if (!answer.ok) throw refusal("invalid_mandate_record", "the mandate record", answer);
    const { ok: _ok, ...facts } = answer;
    return facts as unknown as MandateRecordFacts;
  }

  async function verifyMandateHistory(input: { grant: string; terms: string; uses: readonly string[]; close?: string | null }): Promise<MandateHistoryFacts> {
    const answer = await withTrust((trust) => ({
      op: "mandate_history",
      now: now(),
      trust,
      grant: input.grant,
      terms: input.terms,
      uses: [...input.uses],
      ...(input.close ? { close: input.close } : {}),
    }));
    if (!answer.ok) throw refusal("invalid_mandate_record", "the mandate history", answer);
    const a = answer as unknown as {
      grant: { type: MandateHistoryFacts["grant"]["type"]; mandate: string; app: string; request: string; on_behalf: { org: string; domain: string } | null };
      terms: Record<string, unknown>;
      uses: MandateHistoryFacts["uses"];
      close: MandateHistoryFacts["close"];
    };
    const { on_behalf, ...grant } = a.grant;
    return { grant: { ...grant, onBehalf: on_behalf }, terms: a.terms, uses: a.uses, close: a.close };
  }

  async function verifyLedgerBundle(bundle: string): Promise<LedgerBundleFacts> {
    const answer = await withTrust((trust) => ({ op: "bundle", now: now(), trust, evidence: bundle }));
    if (!answer.ok) throw refusal("ledger_bundle_invalid", "the ledger bundle", answer);
    const a = answer as unknown as { log: string; index: number; committed_by: number; opening: boolean; anchor: { anchored_by: number; tsa: number } | null };
    return {
      log: a.log,
      index: a.index,
      committedBy: a.committed_by,
      opening: a.opening,
      anchor: a.anchor ? { anchoredBy: a.anchor.anchored_by, tsa: a.anchor.tsa } : null,
    };
  }

  async function verifyLedgerNote(note: string): Promise<LedgerNoteFacts> {
    const answer = await withTrust((trust) => ({ op: "ledger_note", now: now(), trust, note }));
    if (!answer.ok) throw refusal("ledger_note_invalid", "the ledger note", answer);
    return { log: answer.log as string, kid: answer.kid as string, body: answer.body as LedgerNoteFacts["body"] };
  }

  async function trust(): Promise<TrustFacts> {
    const answer = await withTrust((t) => ({ op: "trust", now: now(), trust: t }));
    if (!answer.ok) {
      throw new AppClientError("invalid_trust_root", `the trust documents do not chain to trustRoot (${answer.reason})`, undefined, {
        verifierReason: answer.reason,
      });
    }
    return {
      instance: answer.instance as string,
      sealer: answer.sealer as string,
      issuedAt: answer.issued_at as number,
      keys: answer.keys as TrustFacts["keys"],
      logs: answer.logs as TrustFacts["logs"],
      catalogStale: surface.stale(),
    };
  }

  return { trust, verifyReceipt, verifyMandateRecord, verifyMandateHistory, verifyLedgerBundle, verifyLedgerNote };
}
