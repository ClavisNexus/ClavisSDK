/**
 * Builds a delegation request. It normalises the terms (`mandate.terms@1`) by the same rules Clavis
 * uses, and builds the body of a use request (`mandate.use_request@1`).
 *
 * - The terms `mandate.terms@1`: the operations, counterparties, amounts, uses and expiry delegated
 *   to the app, which the user signs with a passkey.
 * - A use request `mandate.use_request@1`: the body, as canonical JSON, with which the app asks for
 *   one action within the terms.
 * - Clavis countersigns and returns the use record `mandate.use@1` and the close record
 *   `mandate.close@1`. The SDK passes each record to the verifier as the string that arrived
 *   (`mandate_record`, `mandate_history`), and reads what it holds from the verifier's answer.
 */
import { canonicalStringify } from "./canonical-json.js";
import { digestOf } from "./digest.js";

export const MANDATE_TERMS = "mandate.terms@1";
export const MANDATE_USE_REQUEST = "mandate.use_request@1";
export const MANDATE_USE = "mandate.use@1";
export const MANDATE_CLOSE = "mandate.close@1";
export const MANDATE_GRANT = "mandate.grant@1";
/** A grant delegated on behalf of an organisation, carrying `org` and `domain` */
export const MANDATE_GRANT_ON_BEHALF = "mandate.grant.on_behalf@1";

export const MANDATE_OPERATIONS_MAX = 16;
export const MANDATE_TARGETS_MAX = 32;
export const MANDATE_USES_MAX = 1000;
export const MANDATE_LABEL_MAX = 80;
/** The cap on an amount, as an integer in the currency's minor unit */
export const MANDATE_AMOUNT_MAX = 1_000_000_000_000_000;
/** The expiry is at most 30 days after the request */
export const MANDATE_LIFETIME_MAX_SEC = 30 * 86_400;
/** The expiry is more than 5 minutes after the request */
export const MANDATE_LIFETIME_MIN_SEC = 300;

/** Why a delegation closed. `signer_designation_ended` belongs only to one granted on behalf of an organisation, when the granter's signer designation ended */
export const MANDATE_CLOSE_REASONS = [
  "account_closed",
  "exhausted",
  "expired",
  "revoked_by_app",
  "revoked_by_holder",
  "signer_designation_ended",
] as const;
export type MandateCloseReason = (typeof MANDATE_CLOSE_REASONS)[number];

/** Why a use fell outside the terms: `violations` on `mandate_outside`, in this order */
export const MANDATE_VIOLATIONS = [
  "agent",
  "amount_missing",
  "amount_not_allowed",
  "amount_per_use",
  "amount_total",
  "expired",
  "operation",
  "target",
  "uses",
] as const;
export type MandateViolation = (typeof MANDATE_VIOLATIONS)[number];

export type MandateOperation = { name: string; label: string };
export type MandateTarget = { id: string; label: string };
export type MandateAgent = { id: string; label: string };
/** Amounts are integers in the currency's minor unit (1 for yen, cents for a dollar). `currency` is an ISO 4217 three-letter code */
export type MandateAmount = { currency: string; total: number; per_use?: number };

/** The terms: the document the user signs. Clavis binds the hash of this canonical form to the grant's statement */
export type MandateTerms = {
  type: typeof MANDATE_TERMS;
  /** In ascending order of `name`, with no duplicates */
  operations: MandateOperation[];
  /** How many uses are allowed (1–1,000) */
  uses: number;
  /** The expiry (Unix seconds). A use after it is refused */
  not_after: number;
  amount?: MandateAmount;
  /** In ascending order of `id`, with no duplicates */
  targets?: MandateTarget[];
  /** To name one actor: the agent's ID, and the name the user sees */
  agent?: MandateAgent;
};

/** The terms as the app passes them. `type` may be omitted. The SDK and Clavis normalise the labels and reorder by the same rules */
export type MandateTermsInput = Omit<MandateTerms, "type"> & { type?: typeof MANDATE_TERMS };

export type MandateUseRequest = {
  type: typeof MANDATE_USE_REQUEST;
  mandate: string;
  /** The use's ID (a UUID). Sending again with the same ID returns the same record */
  use: string;
  operation: string;
  /** The digest of the call you are about to make (`sha256:` + Base64URL) */
  call: string;
  target?: string;
  amount?: number;
  agent?: string;
};

/** The running totals of uses (an amount only when the terms carry one) */
export type MandateCount = { uses: number; amount?: number };

// ---------------------------------------------------------------------------
// Shape

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const OPERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_ID = /^[\x21-\x7e]{1,256}$/;
const AGENT_ID = /^[\x21-\x7e]{1,512}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Characters a label may not carry: control characters, the direction marks (LRM, RLM, ALM), and the bidirectional embeddings, overrides and isolates */
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Normalise a label: NFC, runs of white space collapsed to one, and none at either end. A label that may not be shown is null */
export function normalizeMandateLabel(v: unknown): string | null {
  if (typeof v !== "string" || hasLoneSurrogate(v)) return null;
  const s = v.normalize("NFC").replace(/\s+/g, " ").trim();
  if (s.length === 0 || s.length > MANDATE_LABEL_MAX || UNSHOWABLE.test(s)) return null;
  return s;
}

function isMandateLabel(v: unknown): v is string {
  return typeof v === "string" && normalizeMandateLabel(v) === v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  for (const k of required) if (!(k in o)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}

function isDigest(v: unknown): v is string {
  return typeof v === "string" && DIGEST.test(v);
}

function parseLabelled(v: unknown, key: "name" | "id", check: (x: unknown) => boolean, max: number): boolean {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return false;
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (!isObject(item) || !exactKeys(item, [key, "label"])) return false;
    if (!check(item[key]) || !isMandateLabel(item.label)) return false;
    if (i > 0 && !(String((v[i - 1] as Record<string, unknown>)[key]) < String(item[key]))) return false;
  }
  return true;
}

function parseAmount(v: unknown): boolean {
  if (!isObject(v) || !exactKeys(v, ["currency", "total"], ["per_use"])) return false;
  if (typeof v.currency !== "string" || !CURRENCY.test(v.currency)) return false;
  if (!isInt(v.total, 1, MANDATE_AMOUNT_MAX)) return false;
  if ("per_use" in v && !isInt(v.per_use, 1, v.total)) return false;
  return true;
}

const isOperationName = (v: unknown) => typeof v === "string" && OPERATION_NAME.test(v);
const isTargetId = (v: unknown) => typeof v === "string" && TARGET_ID.test(v);
const isAgentId = (v: unknown) => typeof v === "string" && AGENT_ID.test(v);

/** Check the shape of the terms, which must already be normalised. Anything that fails is null */
export function parseMandateTerms(v: unknown): MandateTerms | null {
  if (!isObject(v) || v.type !== MANDATE_TERMS) return null;
  if (!exactKeys(v, ["type", "operations", "uses", "not_after"], ["amount", "targets", "agent"])) return null;
  if (!parseLabelled(v.operations, "name", isOperationName, MANDATE_OPERATIONS_MAX)) return null;
  if (!isInt(v.uses, 1, MANDATE_USES_MAX)) return null;
  if (!isInt(v.not_after, 0, 100_000_000_000)) return null;
  if ("amount" in v && !parseAmount(v.amount)) return null;
  if ("targets" in v && !parseLabelled(v.targets, "id", isTargetId, MANDATE_TARGETS_MAX)) return null;
  if ("agent" in v) {
    const a = v.agent;
    if (!isObject(a) || !exactKeys(a, ["id", "label"]) || !isAgentId(a.id) || !isMandateLabel(a.label)) return null;
  }
  return v as MandateTerms;
}

export function parseMandateUseRequest(v: unknown): MandateUseRequest | null {
  if (!isObject(v) || v.type !== MANDATE_USE_REQUEST) return null;
  if (!exactKeys(v, ["type", "mandate", "use", "operation", "call"], ["target", "amount", "agent"])) return null;
  if (typeof v.mandate !== "string" || !UUID.test(v.mandate)) return null;
  if (typeof v.use !== "string" || !UUID.test(v.use)) return null;
  if (!isOperationName(v.operation)) return null;
  if (!isDigest(v.call)) return null;
  if ("target" in v && !isTargetId(v.target)) return null;
  if ("amount" in v && !isInt(v.amount, 1, MANDATE_AMOUNT_MAX)) return null;
  if ("agent" in v && !isAgentId(v.agent)) return null;
  return v as MandateUseRequest;
}

// ---------------------------------------------------------------------------
// Preparing the terms, before the request

export type MandateTermsRejection = "shape" | "label" | "duplicate" | "lifetime";

function normalizeList(v: unknown, key: "name" | "id"): Array<Record<string, unknown>> | MandateTermsRejection {
  if (!Array.isArray(v)) return "shape";
  const out: Array<Record<string, unknown>> = [];
  for (const item of v) {
    if (!isObject(item)) return "shape";
    const label = normalizeMandateLabel(item.label);
    if (label === null) return "label";
    out.push({ ...item, label });
  }
  out.sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1]![key] === out[i]![key]) return "duplicate";
  }
  return out;
}

/**
 * Normalise and check the terms by the same rules Clavis uses: labels in NFC with runs of white space
 * collapsed, operations and counterparties in ascending order of identifier. What passes comes back
 * as the form the user signs (`mandate.terms@1`).
 */
export function prepareMandateTerms(
  raw: unknown,
  nowSec: number,
): { ok: true; terms: MandateTerms } | { ok: false; reason: MandateTermsRejection } {
  if (!isObject(raw)) return { ok: false, reason: "shape" };
  if ("type" in raw && raw.type !== MANDATE_TERMS) return { ok: false, reason: "shape" };
  const candidate: Record<string, unknown> = { ...raw, type: MANDATE_TERMS };
  const operations = normalizeList(raw.operations, "name");
  if (typeof operations === "string") return { ok: false, reason: operations };
  candidate.operations = operations;
  if ("targets" in raw) {
    const targets = normalizeList(raw.targets, "id");
    if (typeof targets === "string") return { ok: false, reason: targets };
    candidate.targets = targets;
  }
  if ("agent" in raw) {
    if (!isObject(raw.agent)) return { ok: false, reason: "shape" };
    const label = normalizeMandateLabel(raw.agent.label);
    if (label === null) return { ok: false, reason: "label" };
    candidate.agent = { ...raw.agent, label };
  }
  const terms = parseMandateTerms(candidate);
  if (!terms) return { ok: false, reason: "shape" };
  if (terms.not_after <= nowSec + MANDATE_LIFETIME_MIN_SEC || terms.not_after > nowSec + MANDATE_LIFETIME_MAX_SEC) {
    return { ok: false, reason: "lifetime" };
  }
  return { ok: true, terms };
}

/** The body of a use request, in canonical form: the bytes sent to Clavis */
export function mandateUseRequestBody(request: MandateUseRequest): string {
  return canonicalStringify(request);
}

/** The call's digest (`call`), computed from the JSON value that describes the call you are about to make */
export async function mandateCallDigest(call: unknown): Promise<string> {
  return digestOf(call);
}
