import { SignJWT, importJWK, type JWK, type JWTPayload } from "jose";
import {
  APP_INTENT_REGISTRATION_AUD,
  appIntentRegistrationIssuer,
  buildGenericSignClaims,
  buildMandateClaims,
  REGISTER_TTL_MAX_SEC,
  REGISTER_TTL_MIN_SEC,
  REGISTER_TTL_SEC,
} from "./claims.js";
import { canonicalStringify } from "./canonical-json.js";
import { digestOf } from "./digest.js";
import { AppClientError, type AppClientErrorCode, type AppClientErrorDetails } from "./errors.js";
import { utf8 } from "./ledger/bytes.js";
import { LEDGER_APP_AUTH_SCHEME, signLedgerAppRequest } from "./ledger/request.js";
import {
  MANDATE_GRANT,
  MANDATE_GRANT_ON_BEHALF,
  MANDATE_USE_REQUEST,
  mandateUseRequestBody,
  parseMandateTerms,
  parseMandateUseRequest,
  prepareMandateTerms,
  type MandateCount,
  type MandateTerms,
  type MandateTermsInput,
  type MandateUseRequest,
} from "./mandate.js";
import { APP_SIGN_ON_BEHALF, normalizeOnBehalfDomain, readOnBehalf, type OnBehalf } from "./on-behalf.js";
import {
  commitLedgerRecord,
  finishLedgerHandoff,
  type CommitLedgerInput,
  type FinishLedgerHandoffOptions,
  type LedgerEvidence,
  type LedgerHandoff,
} from "./ledger/handoff.js";
import {
  assertPendingLink,
  buildLinkClaims,
  linkFrom,
  normalizeAppUser,
  type Link,
  type PendingLink,
  type RegisterLinkInput,
  type RegisterLinkResult,
} from "./link.js";
import {
  assertPendingSignIn,
  buildSignInStart,
  checkedReturnUrl,
  parseOrgMembership,
  parseTokenResponse,
  readSignInCallback,
  SIGN_IN_KEY_SLOT,
  verifyIdToken,
  type BeginSignInInput,
  type BeginSignInResult,
  type OrgMembership,
  type PendingSignIn,
  type SignIn,
} from "./sign-in.js";
import {
  createVerifierWithKeys,
  type MandateHistoryFacts,
  type MandateRecordFacts,
  type ReceiptAnchor,
  type Verifier,
  type VerifiedReceipt,
} from "./verify.js";
import type { VerifierModule } from "./verifier.js";

/** Clavis allows 30 status reads a minute for one request. The default interval stays inside that. */
const DEFAULT_WAIT_INTERVAL_MS = 2_500;
/** Upper bound on the gap after a read hits the limit (429) */
const MAX_RATE_LIMITED_BACKOFF_MS = 15_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
/** SHA-256 as Base64URL (unpadded, 43 characters) */
const MESSAGE_DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The user's ID in this app, in the form Clavis's delegation store accepts */
const SUBJECT_RE = /^[A-Za-z0-9._~:@+=/-]{1,200}$/;
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
  /** The Ed25519 operate private JWK, as a JSON string or an object. */
  operatePrivateJwk: string | Record<string, unknown>;
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

export type RegisterGenericSignInput = {
  /**
   * The message_digest the caller prepared (SHA-256 as Base64URL, 43 characters). The SDK does not
   * compute it. Clavis builds the statement `app.sign@1 { app, digest }` from it, and the user signs
   * that with a passkey.
   */
  messageDigest: string;
  /**
   * Where to send the user after signing: https under the app's confirmed host. Omitted, the user ends
   * on Connect's completion screen and finds their own way back to where they started (an agent or a
   * chat screen, for instance).
   */
  returnUrl?: string;
  webhookUrl?: string;
  /**
   * To name one signer: that person's ID in this app, the `sub` from `completeSignIn` or `completeLink`
   * (the same as `sub` on completion). Only that person can sign.
   */
  allowedSub?: string;
  displayHint?: string;
  /**
   * The language of the confirmation screen on Connect. BCP 47 language tags in order of preference
   * (for example `["ja"]`, `["en-GB", "en"]`). Connect chooses from the languages it has open, in this
   * order, ahead of the user's choice and the browser's language. Omitted, the user's choice and the
   * browser's language decide. Use the language you wrote `displayHint` in.
   */
  uiLocales?: readonly string[];
  /**
   * How long the request lives, in seconds (60–900). The user starts signing on Connect within that
   * time. Omitted, it is 120 seconds. It cannot go over the cap set on the app in developers (300
   * seconds by default); over it is `register_failed` (`apiError` is `REGISTRATION_TTL_TOO_LONG`).
   */
  ttlSeconds?: number;
  /**
   * Ask for the signature on behalf of an organisation. `domain` is a domain that organisation
   * confirmed in Clavis through DNS. Only a person designated as a signer for it can sign, and the
   * receipt's statement becomes `app.sign.on_behalf@1`. Turn on "Request on behalf of an
   * organisation" under the app's allowed Intents first.
   */
  onBehalf?: { domain: string };
  signal?: AbortSignal;
};

export type RegisterResult = {
  requestId: string;
  pollSecret: string;
  consumeUrl: string;
  linkConsumeUrl?: string;
  displayCode?: string;
  /** When asked on behalf of an organisation, the domain in the form Clavis accepted. Pass it as `expectedOnBehalf` when you read the completion */
  onBehalf?: { domain: string };
};

export type IntentStatusPending = { state: "pending" };
export type IntentStatusIssued = {
  state: "intent_issued";
  intentType: string;
};
export type IntentStatusCompleted = {
  state: "completed";
  intentType: string;
  /** The signed statement's type ID (`app.sign@1`, or `app.sign.on_behalf@1` on behalf of an organisation) */
  statementType: string;
  /** What was signed. The SDK has checked that it matches the messageDigest from registration */
  messageDigest: string;
  /** The user's ID in this app. It differs from app to app, and is the same as the OIDC `sub` */
  sub: string;
  /** When it was signed (Unix seconds) */
  signedAt: number;
  /** The app receipt (`receipt.app@1`), as the string that arrived. The verifier has checked it. Store it, and show it to the user or a third party */
  receipt: string;
  /** Whether the receipt's mark was appended to the first-party shard, checked against the trust surface's checkpoint and the inclusion proof */
  anchor: ReceiptAnchor;
  /**
   * When signed on behalf of an organisation, that organisation (its ID in Clavis and its domain). The
   * SDK has checked it against the domain you asked for. It shows that Clavis confirmed, at
   * completion, that the person who signed was designated as a signer for that organisation
   */
  onBehalf?: OnBehalf;
};

export type IntentStatus = IntentStatusPending | IntentStatusIssued | IntentStatusCompleted;

export type RegisterMandateInput = {
  /**
   * The terms to delegate: operations, counterparties, amounts, uses, expiry and the actor. A `label`
   * is the wording the user sees, normalised by the same rules Clavis uses (NFC, runs of white space
   * collapsed). Operations and counterparties are reordered by identifier. The expiry (`not_after`) is
   * more than 5 minutes and at most 30 days after the request. Uses run from 1 to 1,000.
   */
  terms: MandateTermsInput;
  /** The user's ID in this app (the same value as the OIDC `sub`). Only this person can sign the delegation */
  allowedSub: string;
  /** Where to send the user after signing: https under the app's confirmed host. Omitted, the user ends on Connect's completion screen */
  returnUrl?: string;
  webhookUrl?: string;
  /** The language of the delegation's confirmation screen on Connect. Use the language you wrote the terms' labels in */
  uiLocales?: readonly string[];
  /** How long the request lives, in seconds (60–900). This is not the delegation's expiry */
  ttlSeconds?: number;
  /**
   * Ask for the delegation on behalf of an organisation. Only a person designated as a signer for it
   * can sign, and the grant's statement becomes `mandate.grant.on_behalf@1`. When the signer
   * designation ends, the delegation closes (reason `signer_designation_ended`)
   */
  onBehalf?: { domain: string };
  signal?: AbortSignal;
};

export type RegisterMandateResult = RegisterResult & {
  /** The delegation's ID and the terms the user signs, normalised. Pass it when you wait for completion */
  mandate: ExpectedMandate;
};

/** The delegation you asked for: its ID, the normalised terms, and the accepted domain when it is on behalf of an organisation. This is `mandate` in `registerMandate`'s result */
export type ExpectedMandate = { id: string; terms: MandateTerms; onBehalf?: { domain: string } };

export type MandateStatusCompleted = {
  state: "completed";
  intentType: string;
  /** The delegation's ID */
  mandate: string;
  /** The terms the user signed. The SDK has checked them against the hash in the receipt's `terms` */
  terms: MandateTerms;
  /** The user's ID in this app */
  sub: string;
  /** When the delegation was signed (Unix seconds) */
  grantedAt: number;
  /** The grant's app receipt (`receipt.app@1`, statement `mandate.grant@1` or `mandate.grant.on_behalf@1`). Store it as the string that arrived, and use it to check the full set of records */
  receipt: string;
  anchor: ReceiptAnchor;
  /** When delegated on behalf of an organisation, that organisation. The SDK has checked it against the domain you asked for */
  onBehalf?: OnBehalf;
};

export type MandateStatus = IntentStatusPending | IntentStatusIssued | MandateStatusCompleted;

export type WaitForMandateOptions = Omit<WaitForCompletionOptions, "expectedMessageDigest" | "expectedOnBehalf">;

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
  /** For a delegation granted on behalf of an organisation, that organisation */
  onBehalf?: OnBehalf;
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

export type StatusOptions = {
  signal?: AbortSignal;
  /**
   * For a request made on behalf of an organisation, the `onBehalf` from `registerGenericSign`'s
   * result. With it, the SDK checks that the receipt is `app.sign.on_behalf@1` for that domain;
   * without it, that the receipt is `app.sign@1`
   */
  expectedOnBehalf?: { domain: string };
};

export type WaitForCompletionOptions = {
  expectedMessageDigest: string;
  /** For a request made on behalf of an organisation, the `onBehalf` from `registerGenericSign`'s result (as in `StatusOptions.expectedOnBehalf`) */
  expectedOnBehalf?: { domain: string };
  /**
   * How long to wait between reads, in milliseconds. Omitted, it is 2,500. Clavis allows 30 status
   * reads a minute for one request; a read that hits the limit (429) leaves the wait running and
   * spaces the next reads further apart.
   */
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type WebhookPing = {
  event: string;
  requestId: string;
  intentType: string;
  state: "completed";
};

export type { CommitLedgerInput, FinishLedgerHandoffOptions, LedgerEvidence, LedgerHandoff };

export type SignInCallOptions = { signal?: AbortSignal };

export type RefreshSignInInput = {
  /** The refresh token from the last sign-in or refresh */
  refreshToken: string;
  /** The user's ID in this app from that sign-in. The new id_token must name the same user */
  sub: string;
  signal?: AbortSignal;
};

export type RevokeSignInOptions = {
  /** Which kind of token `token` is. Omitted, Clavis works it out */
  tokenTypeHint?: "access_token" | "refresh_token";
  signal?: AbortSignal;
};

export type EndSessionUrlInput = {
  /** Where Clavis sends the user after signing out: one of the app's redirect paths, as an https URL */
  postLogoutRedirectUri?: string;
  /** Returned to `postLogoutRedirectUri` as it is */
  state?: string;
  /** The id_token from the sign-in */
  idTokenHint?: string;
};

export type AppClient = {
  registerGenericSign: (input: RegisterGenericSignInput) => Promise<RegisterResult>;
  /** Submit the leaf and return the handoff, which carries the opening. The salt is not sent. */
  commitLedger: (input: CommitLedgerInput) => Promise<LedgerHandoff>;
  /** Add the handoff's opening to the proof bundle (`ledger.bundle@1`), which carries the checkpoint, have the verifier check it, and return it. */
  finishLedgerHandoff: (handoff: LedgerHandoff, options?: FinishLedgerHandoffOptions) => Promise<LedgerEvidence>;
  getStatus: (
    requestId: string,
    pollSecret: string,
    expectedMessageDigest: string,
    options?: StatusOptions,
  ) => Promise<IntentStatus>;
  waitForCompletion: (
    requestId: string,
    pollSecret: string,
    opts: WaitForCompletionOptions,
  ) => Promise<IntentStatusCompleted>;
  /** Read the completion ping. A ping carries no signature and says no more than "come and read status", so read status afterwards */
  readWebhookPing: (body: unknown) => WebhookPing;
  /** Check receipts, delegation records and proof bundles with the verifier, for instance to check a stored receipt later */
  verifier: Verifier;
  /** Ask for a delegation. The user reads the terms on Connect, signs with a passkey, and the delegation opens */
  registerMandate: (input: RegisterMandateInput) => Promise<RegisterMandateResult>;
  getMandateStatus: (
    requestId: string,
    pollSecret: string,
    expected: ExpectedMandate,
    options?: StatusOptions,
  ) => Promise<MandateStatus>;
  waitForMandate: (
    requestId: string,
    pollSecret: string,
    expected: ExpectedMandate,
    opts?: WaitForMandateOptions,
  ) => Promise<MandateStatusCompleted>;
  /** Before each action within the terms, have Clavis check and count it. Outside the terms is refused with `mandate_outside` */
  useMandate: (mandateId: string, input: UseMandateInput) => Promise<MandateUseResult>;
  getMandate: (mandateId: string, options?: MandateCallOptions) => Promise<MandateView>;
  /** Fetch the full set of records, check the grant receipt, the chain of uses and the close, and return them */
  getMandateHistory: (mandateId: string, options?: MandateCallOptions) => Promise<MandateHistory>;
  /** That user's delegations, newest first */
  listMandates: (input: { sub: string; state?: "open" | "closed"; signal?: AbortSignal }) => Promise<MandateView[]>;
  /** Close the delegation from the app's side (reason `revoked_by_app`) */
  revokeMandate: (mandateId: string, options?: MandateCallOptions) => Promise<MandateView>;
  /**
   * Start Sign in with Clavis: the authorization URL to send the user to, and `pending`, which you
   * keep on your server until the user comes back. Nothing is sent to Clavis.
   */
  beginSignIn: (input: BeginSignInInput) => Promise<BeginSignInResult>;
  /**
   * Finish the sign-in on the return to `redirectUri`. The SDK checks `state`, exchanges the code with
   * the PKCE verifier, and checks the id_token. `sub` is the user's ID in this app, the value to pass
   * as `allowedSub`. The user stopping is `declined`; sign-in not open to this app, or the exchange
   * refused, is `unavailable`.
   */
  completeSignIn: (callback: string | URL | URLSearchParams, pending: PendingSignIn, options?: SignInCallOptions) => Promise<SignIn>;
  /** New tokens from the refresh token, with the new id_token checked. A refusal (the user revoked the app, the session ended) is `unavailable` */
  refreshSignIn: (input: RefreshSignInInput) => Promise<SignIn>;
  /** Revoke an access token or a refresh token. Revoking either ends the refresh tokens of that sign-in */
  revokeSignIn: (token: string, options?: RevokeSignInOptions) => Promise<void>;
  /** The URL that signs the user out of Clavis's sign-in screen and sends them to `postLogoutRedirectUri`. Nothing is sent */
  endSessionUrl: (input?: EndSessionUrlInput) => string;
  /** The user's role in the Org that owns this app, read with the access token of a sign-in that asked for `org.role` */
  orgMembership: (accessToken: string, options?: SignInCallOptions) => Promise<OrgMembership>;
  /**
   * Register a request to link the signed-in user's Clavis account (`federation.link`). Show
   * `displayCode` to the user, send them to `consumeUrl`, and keep `pending` on your server.
   */
  registerLink: (input: RegisterLinkInput) => Promise<RegisterLinkResult>;
  /**
   * Read the link's completion, have the verifier check its app receipt, and check that it binds the
   * user, nonce and issuer you asked for. Before the user has signed, it is `link_pending`.
   */
  completeLink: (pending: PendingLink, options?: SignInCallOptions) => Promise<Link>;
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

/** The shape Clavis accepts: BCP 47 language tags, at most 16. A language it does not know is not refused; Connect chooses from the languages it has open. */
const UI_LOCALE_SHAPE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const UI_LOCALE_MAX_LENGTH = 35;
const UI_LOCALES_MAX = 16;

function normalizeUiLocales(input: readonly string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0 || input.length > UI_LOCALES_MAX) {
    throw new AppClientError("invalid_ui_locales", `uiLocales must list 1 to ${UI_LOCALES_MAX} language tags`);
  }
  return input.map((raw) => {
    const tag = typeof raw === "string" ? raw.trim().replace(/_/g, "-") : "";
    if (!tag || tag.length > UI_LOCALE_MAX_LENGTH || !UI_LOCALE_SHAPE.test(tag)) {
      throw new AppClientError("invalid_ui_locales", "uiLocales must be BCP 47 language tags (e.g. ja, en-GB)");
    }
    return tag;
  });
}

async function signOperateJwt(claims: Record<string, unknown>, operateJwk: JWK, appId: string): Promise<string> {
  const key = await importJWK(operateJwk, "EdDSA");
  return await new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(appIntentRegistrationIssuer(appId))
    .setAudience(APP_INTENT_REGISTRATION_AUD)
    .sign(key);
}

function assertApiOriginUrl(raw: string, apiOrigin: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppClientError("invalid_register_response", `${field} is not a URL`);
  }
  if (url.username || url.password || url.origin !== apiOrigin) {
    throw new AppClientError("invalid_register_response", `${field} origin does not match apiOrigin`);
  }
  return url.toString();
}

function parseRegisterPayload(payload: unknown, apiOrigin: string): RegisterResult {
  const rec = asRecord(payload);
  if (!rec) throw new AppClientError("invalid_register_response", "register payload must be an object");
  const requestId = rec.request_id;
  const pollSecret = rec.poll_secret;
  const consumeUrl = rec.consume_url;
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new AppClientError("invalid_register_response", "request_id missing");
  }
  if (typeof pollSecret !== "string" || pollSecret.length === 0) {
    throw new AppClientError("invalid_register_response", "poll_secret missing");
  }
  if (typeof consumeUrl !== "string" || consumeUrl.length === 0) {
    throw new AppClientError("invalid_register_response", "consume_url missing");
  }
  const out: RegisterResult = {
    requestId,
    pollSecret,
    consumeUrl: assertApiOriginUrl(consumeUrl, apiOrigin, "consume_url"),
  };
  if (typeof rec.link_consume_url === "string" && rec.link_consume_url.length > 0) {
    out.linkConsumeUrl = assertApiOriginUrl(rec.link_consume_url, apiOrigin, "link_consume_url");
  }
  if (typeof rec.display_code === "string" && rec.display_code.length > 0) {
    out.displayCode = rec.display_code;
  }
  return out;
}

type StatusRead =
  | IntentStatusPending
  | IntentStatusIssued
  | { state: "completed"; intentType: string; receipt: string; payload: Record<string, unknown> };

/** Read the status body. A completion's receipt comes back as the string it arrived as; checking it with the verifier is the caller's job */
function parseStatusRead(payload: unknown): StatusRead {
  const rec = asRecord(payload);
  if (!rec) throw new AppClientError("invalid_status", "status payload must be an object");
  const state = rec.state;
  if (state === "pending") return { state: "pending" };
  if (state === "intent_issued") {
    const intentType = requiredField(rec, "intent_type");
    if (!intentType) throw new AppClientError("invalid_status", "intent_issued is missing intent_type");
    return { state: "intent_issued", intentType };
  }
  if (state !== "completed") {
    throw new AppClientError("invalid_status", `unexpected status state: ${String(state)}`);
  }
  const intentType = requiredField(rec, "intent_type");
  if (!intentType) throw new AppClientError("invalid_status", "completed status is missing intent_type");
  const receipt = requiredField(rec, "receipt");
  if (!receipt) throw new AppClientError("invalid_status", "completed status is missing its receipt");
  return { state: "completed", intentType, receipt, payload: rec };
}

/**
 * Have the verifier check the completion's receipt, and see that it is an app receipt for this request
 * of this app (`aud` is `request:<the request's ID>`). The facts of the completion are read from what
 * the verifier returns, not from the fields of the response.
 */
async function verifiedCompletion(verifier: Verifier, receipt: string, requestId: string, appId: string): Promise<VerifiedReceipt> {
  const v = await verifier.verifyReceipt(receipt, { expect: { aud: `request:${requestId}` } });
  if (v.type !== "receipt.app@1") throw new AppClientError("receipt_invalid", "the completed status carries a holder receipt, not an app receipt");
  if (v.statement.app !== appId || v.statement.request !== requestId) {
    throw new AppClientError("status_request_mismatch", "the receipt is not for this request of this app");
  }
  return v;
}

/**
 * Check that the receipt's statement and domain match whether the request was made on behalf of an
 * organisation. A receipt that names an organisation when none was asked for, and one that names none
 * when an organisation was asked for, are both refused.
 */
function onBehalfOf(
  verified: VerifiedReceipt,
  plainType: string,
  onBehalfType: string,
  expected: { domain: string } | undefined,
): OnBehalf | null {
  const type = verified.statement.type;
  if (!expected) {
    if (type !== plainType) throw new AppClientError("invalid_status", `completed status receipt is not a ${plainType} signature`);
    return null;
  }
  const onBehalf = type === onBehalfType ? readOnBehalf(verified.statement) : null;
  if (!onBehalf) throw new AppClientError("on_behalf_mismatch", `completed status receipt is not a ${onBehalfType} signature`);
  if (onBehalf.domain !== expected.domain) {
    throw new AppClientError("on_behalf_mismatch", "the signed organization does not match the requested domain");
  }
  return onBehalf;
}

/** Read the signature's completion (statement `app.sign@1`, or `app.sign.on_behalf@1` on behalf of an organisation) from the checked receipt. */
function signStatusFrom(intentType: string, verified: VerifiedReceipt, expectedOnBehalf: { domain: string } | undefined): IntentStatusCompleted {
  const onBehalf = onBehalfOf(verified, "app.sign@1", APP_SIGN_ON_BEHALF, expectedOnBehalf);
  const digest = verified.statement.digest;
  if (typeof digest !== "string" || digest.length === 0) {
    throw new AppClientError("invalid_status", "completed status receipt has no message digest");
  }
  return {
    state: "completed",
    intentType,
    statementType: verified.statement.type,
    messageDigest: digest,
    sub: verified.envelope.signer,
    signedAt: verified.envelope.iat,
    receipt: verified.receipt,
    anchor: verified.anchor,
    ...(onBehalf ? { onBehalf } : {}),
  };
}

/**
 * Read the delegation's completion (statement `mandate.grant@1`, or `mandate.grant.on_behalf@1` on
 * behalf of an organisation), and check that it binds the delegation ID and the hash of the terms you
 * asked for.
 */
async function mandateStatusFrom(intentType: string, verified: VerifiedReceipt, expected: ExpectedMandate): Promise<MandateStatusCompleted> {
  const statement = verified.statement;
  const onBehalf = onBehalfOf(verified, MANDATE_GRANT, MANDATE_GRANT_ON_BEHALF, expected.onBehalf);
  if (statement.mandate !== expected.id || statement.terms !== (await digestOf(expected.terms))) {
    throw new AppClientError("mandate_mismatch", "the signed grant does not bind the requested mandate and terms");
  }
  return {
    state: "completed",
    intentType,
    mandate: expected.id,
    terms: expected.terms,
    sub: verified.envelope.signer,
    grantedAt: verified.envelope.iat,
    receipt: verified.receipt,
    anchor: verified.anchor,
    ...(onBehalf ? { onBehalf } : {}),
  };
}

function requiredField(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assertStatusRequestId(payload: unknown, requestId: string): void {
  const rec = asRecord(payload);
  if (rec?.request_id !== requestId) {
    throw new AppClientError("status_request_mismatch", "signed status is not bound to this request");
  }
}

function assertDigestMatch(status: IntentStatus, expected: string): void {
  if (status.state !== "completed") return;
  if (status.messageDigest !== expected) {
    throw new AppClientError("digest_mismatch", "attested message_digest does not match registration digest");
  }
}

function parseWebhookPing(payload: unknown): WebhookPing {
  const rec = asRecord(payload);
  if (!rec) throw new AppClientError("invalid_webhook_ping", "webhook payload must be an object");
  const event = rec.event;
  const requestId = rec.request_id;
  const intentType = rec.intent_type;
  const state = rec.state;
  if (typeof event !== "string" || event.length === 0) {
    throw new AppClientError("invalid_webhook_ping", "event required");
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new AppClientError("invalid_webhook_ping", "request_id required");
  }
  if (typeof intentType !== "string" || intentType.length === 0) {
    throw new AppClientError("invalid_webhook_ping", "intent_type required");
  }
  if (state !== "completed") {
    throw new AppClientError("invalid_webhook_ping", "state must be completed");
  }
  return { event, requestId, intentType, state: "completed" };
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

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppClientError("aborted", "request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppClientError("aborted", "request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function linkAbortSignals(target: AbortController, signals: AbortSignal[]): () => void {
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      if (!target.signal.aborted) target.abort(signal.reason);
      continue;
    }
    const onAbort = () => {
      if (!target.signal.aborted) target.abort(signal.reason);
    };
    signal.addEventListener("abort", onAbort);
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
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
  const onBehalf = r.on_behalf === undefined ? null : readOnBehalf({ type: MANDATE_GRANT_ON_BEHALF, ...asRecord(r.on_behalf) });
  if (r.on_behalf !== undefined && !onBehalf) return null;
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
      ...(onBehalf ? { onBehalf } : {}),
    },
    close,
  };
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
  const { verifier, trustedKey } = createVerifierWithKeys({
    trustRoot: opts.trustRoot,
    apiOrigin,
    ...(opts.trustOrigins ? { trustOrigins: opts.trustOrigins } : {}),
    ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
    fetchImpl,
  });
  /** The issuer of id_tokens and of links: the API origin */
  const issuer = apiOrigin;

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

  async function postRegister(
    claims: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ result: RegisterResult; payload: Record<string, unknown> }> {
    const registration = await signOperateJwt(claims, operateJwk, appId);
    const res = await request(
      `${apiOrigin}/app/intent-requests/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ registration }),
      },
      signal,
    );
    const body = await readJson(res);
    if (!res.ok) {
      const details = apiErrorDetails(body);
      throw new AppClientError("register_failed", httpFailureMessage("register", res.status, details), res.status, details);
    }
    const rec = asRecord(body);
    const payload = rec ? asRecord(rec.payload) : null;
    if (!payload) {
      throw new AppClientError("invalid_register_response", "register response must be { payload }");
    }
    return { result: parseRegisterPayload(payload, apiOrigin), payload };
  }

  /** Put the on-behalf domain in the form Clavis accepts, or undefined when it is omitted */
  function checkedOnBehalf(raw: { domain: string } | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const domain = normalizeOnBehalfDomain(raw?.domain);
    if (!domain) throw new AppClientError("invalid_on_behalf", "onBehalf.domain must be a domain name (e.g. example.co.jp)");
    return domain;
  }

  function checkedTtl(raw: number | undefined): number {
    const ttl = raw ?? REGISTER_TTL_SEC;
    if (!Number.isInteger(ttl) || ttl < REGISTER_TTL_MIN_SEC || ttl > REGISTER_TTL_MAX_SEC) {
      throw new AppClientError(
        "invalid_ttl",
        `ttlSeconds must be an integer from ${REGISTER_TTL_MIN_SEC} to ${REGISTER_TTL_MAX_SEC}`,
      );
    }
    return ttl;
  }

  async function registerGenericSign(input: RegisterGenericSignInput): Promise<RegisterResult> {
    if (!input.messageDigest || !MESSAGE_DIGEST_RE.test(input.messageDigest)) {
      throw new AppClientError("invalid_message_digest", "messageDigest must be a SHA-256 Base64URL (43 chars)");
    }
    const uiLocales = normalizeUiLocales(input.uiLocales);
    const ttl = checkedTtl(input.ttlSeconds);
    const onBehalfDomain = checkedOnBehalf(input.onBehalf);
    const now = Math.floor(Date.now() / 1000);
    const claims = buildGenericSignClaims({
      appId,
      iat: now,
      exp: now + ttl,
      jti: crypto.randomUUID(),
      messageDigest: input.messageDigest,
      displayHint: input.displayHint,
      returnUrl: input.returnUrl,
      webhookUrl: input.webhookUrl,
      allowedSub: input.allowedSub,
      uiLocales,
      onBehalfDomain,
    });
    const { result } = await postRegister(claims, input.signal);
    return onBehalfDomain ? { ...result, onBehalf: { domain: onBehalfDomain } } : result;
  }

  async function registerMandate(input: RegisterMandateInput): Promise<RegisterMandateResult> {
    const now = Math.floor(Date.now() / 1000);
    // Check by the same rules Clavis uses, and keep the form the user signs, to match against the terms in the response
    const prepared = prepareMandateTerms(input.terms, now);
    if (!prepared.ok) {
      throw new AppClientError("invalid_mandate_terms", `terms rejected (${prepared.reason})`);
    }
    const allowedSub = typeof input.allowedSub === "string" ? input.allowedSub.trim() : "";
    if (!SUBJECT_RE.test(allowedSub)) {
      throw new AppClientError("invalid_allowed_sub", "allowedSub must be the user's ID in this App");
    }
    const uiLocales = normalizeUiLocales(input.uiLocales);
    const ttl = checkedTtl(input.ttlSeconds);
    const onBehalfDomain = checkedOnBehalf(input.onBehalf);
    const claims = buildMandateClaims({
      appId,
      iat: now,
      exp: now + ttl,
      jti: crypto.randomUUID(),
      terms: prepared.terms,
      allowedSub,
      returnUrl: input.returnUrl,
      webhookUrl: input.webhookUrl,
      uiLocales,
      onBehalfDomain,
    });
    const { result, payload } = await postRegister(claims, input.signal);
    const mandate = asRecord(payload.mandate);
    const id = mandate?.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new AppClientError("invalid_register_response", "mandate.id missing");
    }
    const terms = parseMandateTerms(mandate?.terms);
    if (!terms || canonicalStringify(terms) !== canonicalStringify(prepared.terms)) {
      throw new AppClientError("mandate_terms_mismatch", "registered terms differ from the requested terms");
    }
    return { ...result, mandate: { id, terms, ...(onBehalfDomain ? { onBehalf: { domain: onBehalfDomain } } : {}) } };
  }

  async function readStatus(requestId: string, pollSecret: string, signal?: AbortSignal): Promise<StatusRead> {
    if (!requestId.trim() || !pollSecret.trim()) {
      throw new AppClientError("invalid_status_args", "requestId and pollSecret required");
    }
    const res = await request(
      `${apiOrigin}/app/intent-requests/status/${encodeURIComponent(requestId)}`,
      { headers: { "X-Intent-Poll-Secret": pollSecret } },
      signal,
    );
    const body = await readJson(res);
    if (!res.ok) {
      const details = apiErrorDetails(body);
      throw new AppClientError("status_failed", httpFailureMessage("status", res.status, details), res.status, details);
    }
    const payload = asRecord(body)?.payload;
    assertStatusRequestId(payload, requestId);
    return parseStatusRead(payload);
  }

  async function getStatus(
    requestId: string,
    pollSecret: string,
    expectedMessageDigest: string,
    options?: StatusOptions,
  ): Promise<IntentStatus> {
    if (!expectedMessageDigest.trim()) {
      throw new AppClientError("invalid_message_digest", "expectedMessageDigest required");
    }
    const expectedOnBehalf = options?.expectedOnBehalf === undefined ? undefined : { domain: checkedOnBehalf(options.expectedOnBehalf)! };
    const read = await readStatus(requestId, pollSecret, options?.signal);
    if (read.state !== "completed") return read;
    const status = signStatusFrom(read.intentType, await verifiedCompletion(verifier, read.receipt, requestId, appId), expectedOnBehalf);
    assertDigestMatch(status, expectedMessageDigest);
    return status;
  }

  function assertExpectedMandate(expected: ExpectedMandate): void {
    if (!expected || typeof expected.id !== "string" || !UUID_RE.test(expected.id) || !parseMandateTerms(expected.terms)) {
      throw new AppClientError("invalid_status_args", "expected must be the mandate returned by registerMandate");
    }
    if (expected.onBehalf !== undefined && normalizeOnBehalfDomain(expected.onBehalf?.domain) !== expected.onBehalf.domain) {
      throw new AppClientError("invalid_status_args", "expected.onBehalf must be the onBehalf returned by registerMandate");
    }
  }

  async function getMandateStatus(
    requestId: string,
    pollSecret: string,
    expected: ExpectedMandate,
    options?: StatusOptions,
  ): Promise<MandateStatus> {
    assertExpectedMandate(expected);
    const read = await readStatus(requestId, pollSecret, options?.signal);
    if (read.state !== "completed") return read;
    return mandateStatusFrom(read.intentType, await verifiedCompletion(verifier, read.receipt, requestId, appId), expected);
  }

  function throwIfWaitEnded(caller: AbortSignal | undefined, timeoutSignal: AbortSignal, deadline: number): void {
    if (caller?.aborted) {
      throw new AppClientError("aborted", "waitForCompletion aborted", undefined, { cause: caller.reason });
    }
    if (timeoutSignal.aborted || Date.now() >= deadline) {
      throw new AppClientError("timeout", "waitForCompletion timed out");
    }
  }

  async function waitForCompletion(
    requestId: string,
    pollSecret: string,
    waitOpts: WaitForCompletionOptions,
  ): Promise<IntentStatusCompleted> {
    if (!waitOpts?.expectedMessageDigest?.trim()) {
      throw new AppClientError("invalid_message_digest", "expectedMessageDigest required");
    }
    return waitUntilCompleted(
      (signal) =>
        getStatus(requestId, pollSecret, waitOpts.expectedMessageDigest, {
          signal,
          ...(waitOpts.expectedOnBehalf ? { expectedOnBehalf: waitOpts.expectedOnBehalf } : {}),
        }),
      waitOpts,
    );
  }

  async function waitForMandate(
    requestId: string,
    pollSecret: string,
    expected: ExpectedMandate,
    waitOpts: WaitForMandateOptions = {},
  ): Promise<MandateStatusCompleted> {
    assertExpectedMandate(expected);
    return waitUntilCompleted((signal) => getMandateStatus(requestId, pollSecret, expected, { signal }), waitOpts);
  }

  /** Read status until completion. A read that hits the limit (429) spaces the next reads further apart and keeps going */
  async function waitUntilCompleted<T extends { state: string }>(
    readOnce: (signal: AbortSignal) => Promise<T>,
    waitOpts: WaitForMandateOptions,
  ): Promise<Extract<T, { state: "completed" }>> {
    const intervalMs = waitOpts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    const timeoutMs = waitOpts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const sleep = waitOpts.sleep ?? defaultSleep;
    const deadline = Date.now() + timeoutMs;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const linked = new AbortController();
    const unlink = linkAbortSignals(linked, waitOpts.signal ? [waitOpts.signal, timeoutCtrl.signal] : [timeoutCtrl.signal]);
    let pauseMs = intervalMs;
    try {
      for (;;) {
        throwIfWaitEnded(waitOpts.signal, timeoutCtrl.signal, deadline);
        let status: T | null = null;
        try {
          status = await readOnce(linked.signal);
          pauseMs = intervalMs;
        } catch (e) {
          if (e instanceof AppClientError && e.code === "aborted") {
            throwIfWaitEnded(waitOpts.signal, timeoutCtrl.signal, deadline);
          }
          // A read that only hit the limit leaves the wait running: double the interval, up to the cap
          if (!(e instanceof AppClientError && e.code === "status_failed" && e.status === 429)) throw e;
          pauseMs = Math.min(Math.max(pauseMs * 2, intervalMs), MAX_RATE_LIMITED_BACKOFF_MS);
        }
        if (status?.state === "completed") return status as Extract<T, { state: "completed" }>;
        throwIfWaitEnded(waitOpts.signal, timeoutCtrl.signal, deadline);
        try {
          await sleep(pauseMs, linked.signal);
        } catch (e) {
          if (e instanceof AppClientError && e.code === "aborted") {
            throwIfWaitEnded(waitOpts.signal, timeoutCtrl.signal, deadline);
          }
          throw e;
        }
      }
    } finally {
      clearTimeout(timer);
      unlink();
    }
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
    const { json, jwt } = await mandateCall(
      "mandate use",
      "POST",
      `/app/mandates/${mandateId}/uses`,
      body,
      input.signal,
    );
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
    const { json } = await mandateCall(
      "mandate history",
      "GET",
      `/app/mandates/${mandateId}?history=1`,
      undefined,
      options?.signal,
    );
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
    // The organisation the state names and the one the grant bound are the same; for a delegation not on behalf of one, neither names it
    if (canonicalStringify(facts.grant.onBehalf) !== canonicalStringify(view.onBehalf ?? null)) {
      throw new AppClientError("mandate_mismatch", "the mandate's organization differs from the grant");
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

  /** The session key (`wauthn-auth-jwt`) for `kid`, from the aggregate JWKS the verifier checked against trustRoot */
  async function sessionKey(kid: string): Promise<JsonWebKey | null> {
    const key = await trustedKey(kid, SIGN_IN_KEY_SLOT);
    return key && key.alg === "ES256" ? key.jwk : null;
  }

  /** A form POST to the OIDC endpoints. A response that is not JSON reads as null */
  async function postForm(path: string, form: Record<string, string>, signal?: AbortSignal): Promise<{ res: Response; body: unknown }> {
    const res = await request(
      `${apiOrigin}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      },
      signal,
    );
    let body: unknown = null;
    try {
      body = await readJson(res);
    } catch (e) {
      if (res.ok) throw e;
    }
    return { res, body };
  }

  /** Exchange at the token endpoint and check the id_token. Any refusal is `unavailable` */
  async function tokenGrant(
    op: string,
    form: Record<string, string>,
    expect: { nonce?: string; sub?: string },
    signal?: AbortSignal,
  ): Promise<SignIn> {
    const { res, body } = await postForm("/oauth/token", form, signal);
    if (!res.ok) {
      const details = apiErrorDetails(body);
      throw new AppClientError("unavailable", httpFailureMessage(op, res.status, details), res.status, details);
    }
    const tokens = parseTokenResponse(body, Math.floor(Date.now() / 1000));
    const claims = await verifyIdToken(tokens.idToken, {
      issuer,
      appId,
      accessToken: tokens.accessToken,
      key: sessionKey,
      ...(expect.nonce !== undefined ? { nonce: expect.nonce } : {}),
      ...(expect.sub !== undefined ? { sub: expect.sub } : {}),
    });
    return { iss: issuer, ...claims, tokens };
  }

  async function beginSignIn(input: BeginSignInInput): Promise<BeginSignInResult> {
    return buildSignInStart(apiOrigin, appId, input, normalizeUiLocales(input?.uiLocales));
  }

  async function completeSignIn(
    callback: string | URL | URLSearchParams,
    pending: PendingSignIn,
    options?: SignInCallOptions,
  ): Promise<SignIn> {
    assertPendingSignIn(pending);
    const code = readSignInCallback(callback, pending, issuer);
    return tokenGrant(
      "token",
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: appId,
        code_verifier: pending.codeVerifier,
      },
      { nonce: pending.nonce },
      options?.signal,
    );
  }

  async function refreshSignIn(input: RefreshSignInInput): Promise<SignIn> {
    const refreshToken = typeof input?.refreshToken === "string" ? input.refreshToken.trim() : "";
    if (!refreshToken || typeof input.sub !== "string" || !SUBJECT_RE.test(input.sub)) {
      throw new AppClientError("invalid_sign_in_args", "refreshToken and the sub of that sign-in are required");
    }
    return tokenGrant(
      "refresh",
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: appId },
      { sub: input.sub },
      input.signal,
    );
  }

  async function revokeSignIn(token: string, options?: RevokeSignInOptions): Promise<void> {
    const value = typeof token === "string" ? token.trim() : "";
    if (!value) throw new AppClientError("invalid_sign_in_args", "token required");
    const hint = options?.tokenTypeHint;
    if (hint !== undefined && hint !== "access_token" && hint !== "refresh_token") {
      throw new AppClientError("invalid_sign_in_args", "tokenTypeHint must be access_token or refresh_token");
    }
    const { res, body } = await postForm(
      "/oauth/revoke",
      { token: value, client_id: appId, ...(hint ? { token_type_hint: hint } : {}) },
      options?.signal,
    );
    if (!res.ok) {
      const details = apiErrorDetails(body);
      throw new AppClientError("revoke_failed", httpFailureMessage("revoke", res.status, details), res.status, details);
    }
  }

  function endSessionUrl(input: EndSessionUrlInput = {}): string {
    const q = new URLSearchParams({ client_id: appId });
    if (input.postLogoutRedirectUri !== undefined) {
      q.set("post_logout_redirect_uri", checkedReturnUrl(input.postLogoutRedirectUri, "postLogoutRedirectUri"));
    }
    if (input.state !== undefined) q.set("state", input.state);
    if (input.idTokenHint !== undefined) q.set("id_token_hint", input.idTokenHint);
    return `${apiOrigin}/oauth/end-session?${q.toString()}`;
  }

  async function orgMembership(accessToken: string, options?: SignInCallOptions): Promise<OrgMembership> {
    const token = typeof accessToken === "string" ? accessToken.trim() : "";
    if (!token) throw new AppClientError("invalid_sign_in_args", "accessToken required");
    const res = await request(
      `${apiOrigin}/oauth/org-membership`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
      options?.signal,
    );
    let body: unknown = null;
    try {
      body = await readJson(res);
    } catch (e) {
      if (res.ok) throw e;
    }
    if (!res.ok) {
      const details = apiErrorDetails(body);
      throw new AppClientError("org_membership_failed", httpFailureMessage("org membership", res.status, details), res.status, details);
    }
    return parseOrgMembership(body, appId);
  }

  async function registerLink(input: RegisterLinkInput): Promise<RegisterLinkResult> {
    const appUser = normalizeAppUser(input?.appUser);
    const allowedSub =
      input.allowedSub === undefined ? undefined : typeof input.allowedSub === "string" ? input.allowedSub.trim() : "";
    if (allowedSub !== undefined && !SUBJECT_RE.test(allowedSub)) {
      throw new AppClientError("invalid_allowed_sub", "allowedSub must be the user's ID in this App");
    }
    const uiLocales = normalizeUiLocales(input.uiLocales);
    const ttl = checkedTtl(input.ttlSeconds);
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const claims = buildLinkClaims({
      appId,
      iat: now,
      exp: now + ttl,
      jti: crypto.randomUUID(),
      appUser,
      nonce,
      iss: issuer,
      returnUrl: input.returnUrl,
      webhookUrl: input.webhookUrl,
      allowedSub,
      uiLocales,
    });
    const { result } = await postRegister(claims, input.signal);
    if (!result.linkConsumeUrl) throw new AppClientError("invalid_register_response", "link_consume_url missing");
    if (!result.displayCode) throw new AppClientError("invalid_register_response", "display_code missing");
    return {
      requestId: result.requestId,
      consumeUrl: result.linkConsumeUrl,
      displayCode: result.displayCode,
      pending: { requestId: result.requestId, pollSecret: result.pollSecret, appUser, nonce, iss: issuer },
    };
  }

  async function completeLink(pending: PendingLink, options?: SignInCallOptions): Promise<Link> {
    assertPendingLink(pending);
    const read = await readStatus(pending.requestId, pending.pollSecret, options?.signal);
    if (read.state !== "completed") {
      throw new AppClientError("link_pending", `the link has not been signed yet (${read.state})`);
    }
    return linkFrom(await verifiedCompletion(verifier, read.receipt, pending.requestId, appId), pending);
  }

  const ledgerHttp = { apiOrigin, appId, operateJwk, fetchImpl, verifier };

  async function commitLedger(input: CommitLedgerInput): Promise<LedgerHandoff> {
    return commitLedgerRecord({ ...ledgerHttp, signal: input.signal }, input);
  }

  async function finishLedger(handoff: LedgerHandoff, options?: FinishLedgerHandoffOptions): Promise<LedgerEvidence> {
    return finishLedgerHandoff(ledgerHttp, handoff, options);
  }

  return {
    registerGenericSign,
    getStatus,
    waitForCompletion,
    readWebhookPing: parseWebhookPing,
    verifier,
    registerMandate,
    getMandateStatus,
    waitForMandate,
    useMandate,
    getMandate,
    getMandateHistory,
    listMandates,
    revokeMandate,
    commitLedger,
    finishLedgerHandoff: finishLedger,
    beginSignIn,
    completeSignIn,
    refreshSignIn,
    revokeSignIn,
    endSessionUrl,
    orgMembership,
    registerLink,
    completeLink,
  };
}
