import type { JWK } from "jose";
import { canonicalStringify } from "./canonical-json.js";
import { digestOf } from "./digest.js";
import {
  ENTITY_AUTH_SCHEME,
  isSha256Digest,
  loadEntityRequestKey,
  signEntityRequest,
  type EntityRequestKey,
} from "./entity-request.js";
import { AppClientError, type AppClientErrorCode, type AppClientErrorDetails } from "./errors.js";
import { utf8 } from "./ledger/bytes.js";
import { LEDGER_APP_AUTH_SCHEME, signLedgerAppRequest } from "./ledger/request.js";
import {
  MANDATE_USE_REQUEST,
  mandateUseRequestBody,
  parseMandateTerms,
  parseMandateUseRequest,
  type MandateCount,
  type MandateTerms,
  type MandateUseRequest,
} from "./mandate.js";
import {
  commitLedgerRecord,
  finishLedgerHandoff,
  type CommitLedgerInput,
  type FinishLedgerHandoffOptions,
  type LedgerEvidence,
  type LedgerHandoff,
} from "./ledger/handoff.js";
import { createVerifier, type MandateHistoryFacts, type MandateRecordFacts, type Verifier } from "./verify.js";
import type { VerifierModule } from "./verifier.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The user's ID in this app, in the form Clavis's delegation store accepts */
const SUBJECT_RE = /^[A-Za-z0-9._~:@+=/-]{1,200}$/;
const RELAY_SUITE = "webauthn.relayed@1";
/** The delegation store's failure `error` values, mapped to SDK codes */
const MANDATE_FAILURES: Readonly<Record<string, AppClientErrorCode>> = {
  MANDATE_NOT_ALLOWED: "mandate_not_allowed",
  MANDATE_NOT_FOUND: "mandate_not_found",
  MANDATE_CLOSED: "mandate_closed",
  OUTSIDE_MANDATE: "mandate_outside",
  USE_CONFLICT: "mandate_use_conflict",
};

export type CreateAppClientOptions = {
  /** For example `https://api.clavis.nexus` */
  apiOrigin: string;
  appId: string;
  /** The Ed25519 operate private JWK, as a JSON string or an object. Ledger and delegation calls sign with it. */
  operatePrivateJwk: string | Record<string, unknown>;
  /**
   * Entity id (`sha256:` and 43 unpadded Base64URL characters). `sign` and `completeSign` send it as the `entity` claim.
   * Required for those calls.
   */
  entityId?: string;
  /**
   * Entity request private JWK (Ed25519 or P-256), as a JSON string or an object. `sign` and `completeSign` sign
   * `Authorization: ClavisEntity` with it. `kid` is the digest of the public JWK. Required for those calls.
   */
  requestPrivateJwk?: string | Record<string, unknown>;
  /**
   * Clavis's Master public JWK (EC P-256, an object or a JSON string). It is the trust root for
   * receipts, delegation records and proof bundles. Missing, it fails at construction. The 2.x
   * `masterPublicJwkJson` is a different key: passing it is `removed_option`.
   */
  trustRoot: JsonWebKey | string;
  /** Trust surface origins, tried in order. Omitted, it is `apiOrigin` with `api.` replaced by `trust.` (`https://trust.clavis.nexus`) */
  trustOrigins?: readonly string[];
  /** Verifiers to add, for a runtime that cannot compile WASM at runtime (Cloudflare Workers and similar) */
  verifiers?: readonly VerifierModule[];
  fetchImpl?: typeof fetch;
};

/** The statement, the signer and the key id sent to `POST /relay/v1/sign`. */
export type SignInput = {
  /** The statement object. The SDK sends it inside the canonical body and does not rewrite its fields. */
  statement: { type: string } & Record<string, unknown>;
  signer: string;
  /** Key id, `sha256:` and 43 unpadded Base64URL characters. */
  key: string;
  /** Included as `link_lookup` when set, including `null`. */
  linkLookup?: string | null;
  signal?: AbortSignal;
};

/** The relay's answer to `POST /relay/v1/sign`. */
export type SignStarted = {
  envelope: Record<string, unknown>;
  dimension: Record<string, unknown>;
  challenge: string;
};

/**
 * WebAuthn fields for `POST /relay/v1/sign/complete`. `userHandle` and `rawId` are not part of this object
 * and are not sent.
 */
export type SignProof = {
  authenticator_data: string;
  client_data_json: string;
  signature: string;
};

export type CompleteSignInput = {
  /**
   * The `envelope` object from `sign`, or its digest (`sha256:` and 43 unpadded Base64URL characters).
   * The request sends the digest.
   */
  envelope: Record<string, unknown> | string;
  proof: SignProof;
  signal?: AbortSignal;
};

/**
 * The relay's answer to `POST /relay/v1/sign/complete`. `receipt` is the `receipt@2` string as it arrived.
 * `@clavis.nexus/collatio` 1.0.1 refuses that string with `receipt_type`. This result does not say the verifier accepted it.
 */
export type CompletedSign = { receipt: string };

export type UseMandateInput = {
  /** The operation's name in the terms */
  operation: string;
  /** The digest of the call you are about to make (`sha256:` + Base64URL). Compute it with `mandateCallDigest(...)` */
  call: string;
  /** When the terms name counterparties, that counterparty's identifier */
  target?: string;
  /** When the terms carry an amount, this use's amount, as an integer in the currency's minor unit */
  amount?: number;
  /** When the terms name one actor, that actor's ID */
  agent?: string;
  /**
   * The use's ID (a UUID). Omitted, the SDK makes one. When no response arrived, send again with the
   * same ID: the same record comes back, and it is counted once.
   */
  use?: string;
  signal?: AbortSignal;
};

/** The use record, as the verifier read it */
export type MandateUseFacts = Extract<MandateRecordFacts, { type: "mandate.use@1" }>;
/** The close record, as the verifier read it */
export type MandateCloseFacts = Extract<MandateRecordFacts, { type: "mandate.close@1" }>;

export type MandateUseResult = {
  /** The record Clavis counted after checking the use falls inside the terms (`mandate.use@1`). Store it as the string that arrived */
  record: string;
  /** What the verifier read from the record: Clavis's countersignature, and the app's JWT */
  use: MandateUseFacts;
  /** True when the same use ID was sent again and the earlier record came back */
  replayed: boolean;
  /** The close record, when this use ran out the uses or the amount and closed the delegation */
  close: { record: string; facts: MandateCloseFacts } | null;
};

/** The delegation's current state */
export type MandateView = {
  id: string;
  appId: string;
  /** The user's ID in this app */
  sub: string;
  terms: MandateTerms;
  /** The digest of the grant's binding (`grant` in the records) */
  grant: string;
  openedAt: number;
  state: "open" | "closed";
  /** The running totals of uses (an amount only when the terms carry one) */
  totals: MandateCount;
  /** When closed, the close record: the string that arrived, and what the verifier read from it */
  close: { record: string; facts: MandateCloseFacts } | null;
};

/** The position in the ledger: the customer Org's log, where the grant, use and close commitments were appended */
export type MandateLedgerPosition = { logId: string; index: number; receipt: string };

/** The full set of records. The verifier has checked the grant receipt, the chain of uses and the close together */
export type MandateHistory = {
  view: MandateView;
  /** The grant's app receipt, as the string that arrived */
  grantReceipt: string;
  /** What the verifier read from the full set of records */
  facts: MandateHistoryFacts;
  uses: Array<{ record: string; ledger: MandateLedgerPosition | null }>;
  ledger: { grant: MandateLedgerPosition | null; close: MandateLedgerPosition | null };
};

export type MandateCallOptions = { signal?: AbortSignal };

export type { CommitLedgerInput, FinishLedgerHandoffOptions, LedgerEvidence, LedgerHandoff };

export type AppClient = {
  /** Bind a statement. `POST /relay/v1/sign`, `Authorization: ClavisEntity`, body RFC 8785 canonical JSON. */
  sign: (input: SignInput) => Promise<SignStarted>;
  /** Finish the signature. `POST /relay/v1/sign/complete`. Returns the `receipt@2` string without asking the bundled verifier to accept it. */
  completeSign: (input: CompleteSignInput) => Promise<CompletedSign>;
  /** Submit the leaf and return the handoff, which carries the opening. The salt is not sent. */
  commitLedger: (input: CommitLedgerInput) => Promise<LedgerHandoff>;
  /** Add the handoff's opening to the proof bundle (`ledger.bundle@1`), which carries the checkpoint, have the verifier check it, and return it. */
  finishLedgerHandoff: (handoff: LedgerHandoff, options?: FinishLedgerHandoffOptions) => Promise<LedgerEvidence>;
  /** Check receipts, delegation records and proof bundles with the verifier, for instance to check a stored receipt later */
  verifier: Verifier;
  /** Before each action within the terms, have Clavis check and count it. Outside the terms is refused with `mandate_outside` */
  useMandate: (mandateId: string, input: UseMandateInput) => Promise<MandateUseResult>;
  getMandate: (mandateId: string, options?: MandateCallOptions) => Promise<MandateView>;
  /** Fetch the full set of records, check the grant receipt, the chain of uses and the close, and return them */
  getMandateHistory: (mandateId: string, options?: MandateCallOptions) => Promise<MandateHistory>;
  /** That user's delegations, newest first */
  listMandates: (input: { sub: string; state?: "open" | "closed"; signal?: AbortSignal }) => Promise<MandateView[]>;
  /** Close the delegation from the app's side (reason `revoked_by_app`) */
  revokeMandate: (mandateId: string, options?: MandateCallOptions) => Promise<MandateView>;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function apiErrorDetails(body: unknown): AppClientErrorDetails {
  const rec = asRecord(body);
  if (!rec) return {};
  const details: AppClientErrorDetails = {};
  if (typeof rec.error === "string" && rec.error.length > 0) details.apiError = rec.error;
  if (typeof rec.message === "string" && rec.message.length > 0) details.apiMessage = rec.message;
  if (typeof rec.trace_id === "string" && rec.trace_id.length > 0) details.traceId = rec.trace_id;
  return details;
}

function httpFailureMessage(op: string, status: number, details: AppClientErrorDetails): string {
  return details.apiError ? `${op} HTTP ${status} ${details.apiError}` : `${op} HTTP ${status}`;
}

function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppClientError("invalid_api_origin", "apiOrigin must be an absolute URL");
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new AppClientError("invalid_api_origin", "apiOrigin must be https");
  }
  if (u.username || u.password) {
    throw new AppClientError("invalid_api_origin", "apiOrigin must not contain credentials");
  }
  return u.origin;
}

function parseOperateJwk(raw: string | Record<string, unknown>): JWK {
  const json = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
  if (!json) throw new AppClientError("invalid_operate_jwk", "operatePrivateJwk required");
  let jwk: JWK;
  try {
    jwk = JSON.parse(json) as JWK;
  } catch {
    throw new AppClientError("invalid_operate_jwk", "operatePrivateJwk must be JSON");
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new AppClientError("invalid_operate_jwk", "operatePrivateJwk must be Ed25519 (alg EdDSA)");
  }
  if (typeof jwk.d !== "string" || jwk.d.length === 0) {
    throw new AppClientError("invalid_operate_jwk", "operatePrivateJwk must include the private parameter d");
  }
  if (!jwk.alg) jwk.alg = "EdDSA";
  return jwk;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppClientError("invalid_json", "response body is not JSON", res.status);
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function mandateFailure(op: string, status: number, body: unknown): AppClientError {
  const details = apiErrorDetails(body);
  const rec = asRecord(body);
  if (Array.isArray(rec?.violations) && rec.violations.every((v) => typeof v === "string")) {
    details.violations = rec.violations as string[];
  }
  const code = (details.apiError && MANDATE_FAILURES[details.apiError]) || "mandate_failed";
  const reason = typeof rec?.reason === "string" ? ` (${rec.reason})` : "";
  return new AppClientError(code, `${httpFailureMessage(op, status, details)}${reason}`, status, details);
}

function parseLedgerPosition(v: unknown): MandateLedgerPosition | null {
  const r = asRecord(v);
  if (!r || typeof r.log_id !== "string" || typeof r.index !== "number" || typeof r.receipt !== "string") return null;
  return { logId: r.log_id, index: r.index, receipt: r.receipt };
}

/** Read the shape of the delegation's state. The close record comes back as the string it arrived as; checking it with the verifier is the caller's job */
function parseMandateView(v: unknown): { view: Omit<MandateView, "close">; close: string | null } | null {
  const r = asRecord(v);
  if (!r) return null;
  const terms = parseMandateTerms(r.terms);
  const totals = asRecord(r.totals);
  if (
    !terms ||
    typeof r.mandate !== "string" ||
    !UUID_RE.test(r.mandate) ||
    typeof r.app_id !== "string" ||
    typeof r.subject !== "string" ||
    typeof r.grant !== "string" ||
    typeof r.opened_at !== "number" ||
    (r.state !== "open" && r.state !== "closed") ||
    !totals ||
    typeof totals.uses !== "number" ||
    (totals.amount !== undefined && typeof totals.amount !== "number")
  ) {
    return null;
  }
  const close = r.close === null || r.close === undefined ? null : r.close;
  if (close !== null && typeof close !== "string") return null;
  if ((r.state === "closed") !== (close !== null)) return null;
  return {
    view: {
      id: r.mandate,
      appId: r.app_id,
      sub: r.subject,
      terms,
      grant: r.grant,
      openedAt: r.opened_at,
      state: r.state,
      totals: totals.amount === undefined ? { uses: totals.uses } : { uses: totals.uses, amount: totals.amount },
    },
    close,
  };
}

/** The string is JSON whose `type` is `receipt@2`. The original string is what the caller keeps. */
function isReceipt2(receipt: string): boolean {
  try {
    const parsed = JSON.parse(receipt) as unknown;
    return asRecord(parsed)?.type === "receipt@2";
  } catch {
    return false;
  }
}

function proofFields(proof: SignProof): SignProof {
  const authenticator_data = proof?.authenticator_data;
  const client_data_json = proof?.client_data_json;
  const signature = proof?.signature;
  if (
    typeof authenticator_data !== "string" ||
    authenticator_data.length === 0 ||
    typeof client_data_json !== "string" ||
    client_data_json.length === 0 ||
    typeof signature !== "string" ||
    signature.length === 0
  ) {
    throw new AppClientError("invalid_sign_input", "proof must carry authenticator_data, client_data_json and signature");
  }
  return { authenticator_data, client_data_json, signature };
}

export function createAppClient(opts: CreateAppClientOptions): AppClient {
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  const appId = opts.appId.trim();
  if (!appId) throw new AppClientError("invalid_app_id", "appId required");
  const operateJwk = parseOperateJwk(opts.operatePrivateJwk);
  if ("masterPublicJwkJson" in (opts as Record<string, unknown>)) {
    // The 2.x masterPublicJwkJson is a different key: never read it as trustRoot
    throw new AppClientError("removed_option", "masterPublicJwkJson was removed in 3.0; pass the Master public JWK as trustRoot");
  }
  if (opts.trustRoot === undefined) throw new AppClientError("invalid_trust_root", "trustRoot (the Master public JWK) is required");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const verifier = createVerifier({
    trustRoot: opts.trustRoot,
    apiOrigin,
    ...(opts.trustOrigins ? { trustOrigins: opts.trustOrigins } : {}),
    ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
    fetchImpl,
  });

  function entityId(): string {
    const id = typeof opts.entityId === "string" ? opts.entityId.trim() : "";
    if (!isSha256Digest(id)) {
      throw new AppClientError("invalid_entity_id", "entityId must be sha256: and 43 unpadded Base64URL characters");
    }
    return id;
  }

  let requestKeyPromise: Promise<EntityRequestKey> | null = null;
  function requestKey(): Promise<EntityRequestKey> {
    if (opts.requestPrivateJwk === undefined) {
      throw new AppClientError("invalid_request_jwk", "requestPrivateJwk is required to sign");
    }
    requestKeyPromise ??= loadEntityRequestKey(opts.requestPrivateJwk);
    return requestKeyPromise;
  }

  async function request(url: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new AppClientError("aborted", "request aborted", undefined, { cause: signal.reason });
    try {
      return await fetchImpl(url, { ...init, redirect: "error", signal });
    } catch (e) {
      if (isAbortError(e, signal)) {
        throw new AppClientError("aborted", "request aborted", undefined, { cause: e });
      }
      throw new AppClientError("network_error", "request failed", undefined, { cause: e });
    }
  }

  async function relayPost(path: "/relay/v1/sign" | "/relay/v1/sign/complete", value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const url = `${apiOrigin}${path}`;
    const body = canonicalStringify(value);
    const bytes = utf8(body);
    let authorization: string;
    try {
      authorization = `${ENTITY_AUTH_SCHEME} ${await signEntityRequest({
        key: await requestKey(),
        entity: entityId(),
        method: "POST",
        url,
        body: bytes,
      })}`;
    } catch (e) {
      if (e instanceof AppClientError) throw e;
      throw new AppClientError("invalid_sign_input", "the relay request could not be signed", undefined, { cause: e });
    }
    const res = await request(
      url,
      { method: "POST", headers: { authorization, "content-type": "application/json" }, body },
      signal,
    );
    const json = await readJson(res);
    if (!res.ok) {
      const details = apiErrorDetails(json);
      throw new AppClientError("sign_failed", httpFailureMessage(path, res.status, details), res.status, details);
    }
    return json;
  }

  async function sign(input: SignInput): Promise<SignStarted> {
    const statement = asRecord(input?.statement);
    if (!statement || typeof statement.type !== "string" || statement.type.length === 0) {
      throw new AppClientError("invalid_sign_input", "statement must be an object with a type");
    }
    const signer = typeof input.signer === "string" ? input.signer : "";
    if (signer.length === 0 || signer.length > 200) throw new AppClientError("invalid_sign_input", "signer is required");
    if (typeof input.key !== "string" || !isSha256Digest(input.key)) {
      throw new AppClientError("invalid_sign_input", "key must be sha256: and 43 unpadded Base64URL characters");
    }
    const body: Record<string, unknown> = { key: input.key, signer, statement, suite: RELAY_SUITE };
    if (input.linkLookup !== undefined) body.link_lookup = input.linkLookup;
    const json = await relayPost("/relay/v1/sign", body, input.signal);
    const rec = asRecord(json);
    const envelope = rec ? asRecord(rec.envelope) : null;
    const dimension = rec ? asRecord(rec.dimension) : null;
    const challenge = rec && typeof rec.challenge === "string" ? rec.challenge : "";
    if (!envelope || !dimension || challenge.length === 0) {
      throw new AppClientError("invalid_sign_response", "sign response must be { envelope, dimension, challenge }");
    }
    return { envelope, dimension, challenge };
  }

  async function completeSign(input: CompleteSignInput): Promise<CompletedSign> {
    const proof = proofFields(input?.proof);
    let envelope: string;
    if (typeof input?.envelope === "string") {
      if (!isSha256Digest(input.envelope)) {
        throw new AppClientError("invalid_sign_input", "envelope digest must be sha256: and 43 unpadded Base64URL characters");
      }
      envelope = input.envelope;
    } else if (asRecord(input?.envelope)) {
      envelope = await digestOf(input.envelope);
    } else {
      throw new AppClientError("invalid_sign_input", "envelope must be the object from sign, or its digest");
    }
    const json = await relayPost("/relay/v1/sign/complete", { envelope, proof }, input.signal);
    const receipt = asRecord(json)?.receipt;
    if (typeof receipt !== "string" || !isReceipt2(receipt)) {
      throw new AppClientError("invalid_sign_response", "sign completion must return a receipt@2 string");
    }
    return { receipt };
  }

  /** Have the verifier check the close record, and see that it closes this grant of this delegation */
  async function verifiedClose(record: string, mandateId: string, grant: string): Promise<{ record: string; facts: MandateCloseFacts }> {
    const facts = await verifier.verifyMandateRecord(record);
    if (facts.type !== "mandate.close@1" || facts.mandate !== mandateId || facts.grant !== grant) {
      throw new AppClientError("invalid_mandate_record", "the close record is not this mandate's");
    }
    return { record, facts };
  }

  function assertMandateId(mandateId: string): void {
    if (typeof mandateId !== "string" || !UUID_RE.test(mandateId)) {
      throw new AppClientError("invalid_mandate_id", "mandateId must be the mandate UUID");
    }
  }

  /** A request to the delegation store (`Authorization: ClavisApp <a JWT from the operate key>`, with `jti` used once) */
  async function mandateCall(
    op: string,
    method: "GET" | "POST",
    pathAndQuery: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ json: unknown; jwt: string }> {
    const bytes = body === undefined ? undefined : utf8(body);
    const jwt = await signLedgerAppRequest({ appId, operatePrivateJwk: operateJwk, method, pathAndQuery, body: bytes });
    const res = await request(
      `${apiOrigin}${pathAndQuery}`,
      {
        method,
        headers: {
          authorization: `${LEDGER_APP_AUTH_SCHEME} ${jwt}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      },
      signal,
    );
    const json = await readJson(res);
    if (!res.ok) throw mandateFailure(op, res.status, json);
    return { json, jwt };
  }

  async function verifiedView(raw: unknown, op: string): Promise<MandateView> {
    const parsed = parseMandateView(raw);
    if (!parsed || parsed.view.appId !== appId) throw new AppClientError("invalid_mandate_record", `${op} returned an invalid mandate`);
    const close = parsed.close === null ? null : await verifiedClose(parsed.close, parsed.view.id, parsed.view.grant);
    return { ...parsed.view, close };
  }

  async function useMandate(mandateId: string, input: UseMandateInput): Promise<MandateUseResult> {
    assertMandateId(mandateId);
    const draft: Record<string, unknown> = {
      type: MANDATE_USE_REQUEST,
      mandate: mandateId,
      use: input.use ?? crypto.randomUUID(),
      operation: input.operation,
      call: input.call,
    };
    if (input.target !== undefined) draft.target = input.target;
    if (input.amount !== undefined) draft.amount = input.amount;
    if (input.agent !== undefined) draft.agent = input.agent;
    const useRequest: MandateUseRequest | null = parseMandateUseRequest(draft);
    if (!useRequest) {
      throw new AppClientError("invalid_mandate_use", "use request is not a valid mandate.use_request@1");
    }
    // The body is the canonical form itself: the JWT's body_sha256 binds to these bytes, and the record binds to this body
    const body = mandateUseRequestBody(useRequest);
    const { json, jwt } = await mandateCall("mandate use", "POST", `/app/mandates/${mandateId}/uses`, body, input.signal);
    const rec = asRecord(json);
    const record = rec?.record;
    if (typeof record !== "string") throw new AppClientError("invalid_mandate_record", "mandate use returned no record");
    // Have the verifier check the record: Clavis's countersignature, and that the app's JWT is this app's
    const use = await verifier.verifyMandateRecord(record, { app: appId });
    if (use.type !== "mandate.use@1" || use.mandate !== mandateId) {
      throw new AppClientError("invalid_mandate_record", "mandate use returned a record for another mandate");
    }
    if (use.request !== (await digestOf(useRequest))) {
      throw new AppClientError("invalid_mandate_record", "the recorded request differs from the request sent");
    }
    const replayed = rec?.replayed === true;
    // A replayed record carries the JWT from the first send
    if (!replayed && use.jwt !== jwt) {
      throw new AppClientError("invalid_mandate_record", "the record does not carry this request's JWT");
    }
    const close =
      rec?.close === undefined || rec.close === null
        ? null
        : typeof rec.close === "string"
          ? await verifiedClose(rec.close, mandateId, use.grant)
          : (() => {
              throw new AppClientError("invalid_mandate_record", "mandate use returned an invalid close record");
            })();
    return { record, use, replayed, close };
  }

  async function getMandate(mandateId: string, options?: MandateCallOptions): Promise<MandateView> {
    assertMandateId(mandateId);
    const { json } = await mandateCall("mandate", "GET", `/app/mandates/${mandateId}`, undefined, options?.signal);
    const view = await verifiedView(json, "mandate");
    if (view.id !== mandateId) throw new AppClientError("invalid_mandate_record", "mandate returned another mandate");
    return view;
  }

  async function getMandateHistory(mandateId: string, options?: MandateCallOptions): Promise<MandateHistory> {
    assertMandateId(mandateId);
    const { json } = await mandateCall("mandate history", "GET", `/app/mandates/${mandateId}?history=1`, undefined, options?.signal);
    const rec = asRecord(json);
    const view = await verifiedView(rec?.view, "mandate history");
    if (view.id !== mandateId) throw new AppClientError("invalid_mandate_record", "mandate history returned another mandate");
    const grantReceipt = rec?.grant_receipt;
    if (typeof grantReceipt !== "string") throw new AppClientError("invalid_mandate_record", "mandate history has no grant receipt");
    const entries = (Array.isArray(rec?.uses) ? rec.uses : []).map((u) => asRecord(u));
    if (entries.some((e) => !e || typeof e.record !== "string")) {
      throw new AppClientError("invalid_mandate_record", "mandate history uses are malformed");
    }
    // The verifier checks the grant receipt, the terms, the chain of uses and the close together; pass each record as the string that arrived
    const facts = await verifier.verifyMandateHistory({
      grant: grantReceipt,
      terms: canonicalStringify(view.terms),
      uses: entries.map((e) => e!.record as string),
      close: view.close?.record ?? null,
    });
    if (facts.grant.mandate !== mandateId || facts.grant.app !== appId) {
      throw new AppClientError("mandate_mismatch", "the grant receipt is not for this mandate of this app");
    }
    const last = facts.uses[facts.uses.length - 1];
    const totals: MandateCount = last ? last.totals : { uses: 0, ...(view.terms.amount ? { amount: 0 } : {}) };
    if (canonicalStringify(totals) !== canonicalStringify(view.totals)) {
      throw new AppClientError("invalid_mandate_record", "mandate totals do not match its records");
    }
    const ledger = asRecord(rec?.ledger);
    return {
      view,
      grantReceipt,
      facts,
      uses: entries.map((e) => ({ record: e!.record as string, ledger: parseLedgerPosition(e!.ledger) })),
      ledger: { grant: parseLedgerPosition(ledger?.grant), close: parseLedgerPosition(ledger?.close) },
    };
  }

  async function listMandates(input: { sub: string; state?: "open" | "closed"; signal?: AbortSignal }): Promise<MandateView[]> {
    const sub = typeof input?.sub === "string" ? input.sub.trim() : "";
    if (!SUBJECT_RE.test(sub)) throw new AppClientError("invalid_allowed_sub", "sub must be the user's ID in this App");
    if (input.state !== undefined && input.state !== "open" && input.state !== "closed") {
      throw new AppClientError("invalid_status_args", "state must be open or closed");
    }
    const q = new URLSearchParams({ subject: sub, ...(input.state ? { state: input.state } : {}) });
    const { json } = await mandateCall("mandates", "GET", `/app/mandates?${q.toString()}`, undefined, input.signal);
    const list = asRecord(json)?.mandates;
    if (!Array.isArray(list)) throw new AppClientError("invalid_mandate_record", "mandates must be a list");
    const out: MandateView[] = [];
    for (const raw of list) {
      const view = await verifiedView(raw, "mandates");
      if (view.sub !== sub) throw new AppClientError("invalid_mandate_record", "mandates returned another user's mandate");
      out.push(view);
    }
    return out;
  }

  async function revokeMandate(mandateId: string, options?: MandateCallOptions): Promise<MandateView> {
    assertMandateId(mandateId);
    const { json } = await mandateCall("mandate revoke", "POST", `/app/mandates/${mandateId}/revoke`, undefined, options?.signal);
    const view = await verifiedView(json, "mandate revoke");
    if (view.id !== mandateId || view.state !== "closed") {
      throw new AppClientError("invalid_mandate_record", "mandate revoke did not close the mandate");
    }
    return view;
  }

  const ledgerHttp = { apiOrigin, appId, operateJwk, fetchImpl, verifier };

  async function commitLedger(input: CommitLedgerInput): Promise<LedgerHandoff> {
    return commitLedgerRecord({ ...ledgerHttp, signal: input.signal }, input);
  }

  async function finishLedger(handoff: LedgerHandoff, options?: FinishLedgerHandoffOptions): Promise<LedgerEvidence> {
    return finishLedgerHandoff(ledgerHttp, handoff, options);
  }

  return {
    sign,
    completeSign,
    verifier,
    useMandate,
    getMandate,
    getMandateHistory,
    listMandates,
    revokeMandate,
    commitLedger,
    finishLedgerHandoff: finishLedger,
  };
}
