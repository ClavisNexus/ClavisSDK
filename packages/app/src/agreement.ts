/**
 * Agreements: asking a user to agree to an app's terms, privacy notice or another step on Connect, reading the decision,
 * and checking before an action whether an agreement is in force and on today's terms.
 *
 * A grant or a reconsent is signed with the user's passkey: its app receipt carries the statement `lex.agree@1`
 * (`request`, `org`, `app`, `action`, `use_case`, and `shown`, the digest of the set of texts shown). A refusal (`deny`)
 * or a withdrawal is not signed; Clavis keeps the decision and reports it with its ID.
 */
import { AppClientError } from "./errors.js";
import type { ReceiptAnchor, VerifiedReceipt } from "./verify.js";

/** The statement a grant or a reconsent is signed under. */
export const AGREEMENT_STATEMENT = "lex.agree@1";

/** The steps an app can ask an agreement for. */
export const AGREEMENT_USE_CASES = [
  "login",
  "tos",
  "privacy_ack",
  "third_party_jp",
  "third_party_foreign",
  "sensitive_acquire",
  "marketing",
  "terminal",
] as const;
export type AgreementUseCase = (typeof AGREEMENT_USE_CASES)[number];

/** What the app asks for. Omitted, `grant`. */
export const AGREEMENT_CEREMONIES = ["grant", "reconsent", "withdraw"] as const;
export type AgreementCeremony = (typeof AGREEMENT_CEREMONIES)[number];

/** What the user did. `deny` is the decline beside a grant or a reconsent. */
export type AgreementAction = "grant" | "reconsent" | "deny" | "withdraw";

/** The user's age band, when the app gives it. */
export const AGREEMENT_AGE_BANDS = ["u13", "13_15", "16_17", "18_plus", "unknown"] as const;
export type AgreementAgeBand = (typeof AGREEMENT_AGE_BANDS)[number];

/** What the app says the age band rests on. Recorded as the app's statement; Clavis does not check it. */
export const AGREEMENT_AGE_METHODS = ["self_assertion", "platform_signal", "wallet_credential", "app_kyc", "unspecified"] as const;
export type AgreementAgeMethod = (typeof AGREEMENT_AGE_METHODS)[number];

/** The agreement you asked for. This is `agreement` in `registerAgreement`'s result. Pass it when you read the decision. */
export type ExpectedAgreement = { useCase: AgreementUseCase; ceremony: AgreementCeremony };

export type AgreementStatusCompleted = {
  state: "completed";
  intentType: "agreement";
  action: AgreementAction;
  /** The decision's ID. Your organisation reads the decision, with its record and ledger proof, by this ID */
  decisionId: string;
  useCase: AgreementUseCase;
  /** For a grant or a reconsent: the user's ID in this app, when it was signed, and the app receipt as the string that arrived. The verifier has checked the receipt */
  sub?: string;
  signedAt?: number;
  receipt?: string;
  anchor?: ReceiptAnchor;
};

/** Whether an agreement is in force for a user and a step, and whether it was given on today's terms. */
export type AgreementState =
  | { state: "none" }
  | { state: "open"; decisionId: string; since: string; reconsentRequired: boolean };

/** Which actions can complete an agreement of this kind: what was asked, a reconsent in place of a grant on changed terms, or a decline. */
export function agreementActionAllowed(ceremony: AgreementCeremony, action: string): action is AgreementAction {
  if (ceremony === "withdraw") return action === "withdraw";
  if (ceremony === "reconsent") return action === "reconsent" || action === "deny";
  return action === "grant" || action === "reconsent" || action === "deny";
}

const DECISION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Read a completed agreement. For a grant or a reconsent, `verified` is the app receipt as the verifier read it (it has
 * already checked that it is for this request of this app); its statement must be `lex.agree@1` with the action and the
 * use case. A refusal or a withdrawal carries no receipt.
 */
export function agreementStatusFrom(
  payload: Record<string, unknown>,
  verified: VerifiedReceipt | null,
  expected: ExpectedAgreement,
): AgreementStatusCompleted {
  const action = payload.action;
  const decisionId = payload.decision_id;
  if (typeof action !== "string" || !agreementActionAllowed(expected.ceremony, action)) {
    throw new AppClientError("agreement_mismatch", `the agreement was completed with an action that does not answer a ${expected.ceremony}`);
  }
  if (typeof decisionId !== "string" || !DECISION_ID.test(decisionId)) {
    throw new AppClientError("invalid_status", "the completed agreement has no decision ID");
  }
  const base = { state: "completed" as const, intentType: "agreement" as const, action, decisionId, useCase: expected.useCase };
  const signed = action === "grant" || action === "reconsent";
  if (!signed) {
    if (verified) throw new AppClientError("invalid_status", "a refusal or a withdrawal carries no receipt");
    return base;
  }
  if (!verified) throw new AppClientError("invalid_status", "a grant or a reconsent carries its receipt");
  const statement = verified.statement;
  if (statement.type !== AGREEMENT_STATEMENT || statement.action !== action || statement.use_case !== expected.useCase) {
    throw new AppClientError("agreement_mismatch", "the signed agreement is not the one asked for");
  }
  return {
    ...base,
    sub: verified.envelope.signer,
    signedAt: verified.envelope.iat,
    receipt: verified.receipt,
    anchor: verified.anchor,
  };
}

/** Read the agreement state Clavis answered with. */
export function parseAgreementState(raw: unknown): AgreementState {
  const r = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (r?.state === "none") return { state: "none" };
  if (
    r?.state === "open" &&
    typeof r.decision_id === "string" &&
    DECISION_ID.test(r.decision_id) &&
    typeof r.since === "string" &&
    typeof r.reconsent_required === "boolean"
  ) {
    return { state: "open", decisionId: r.decision_id, since: r.since, reconsentRequired: r.reconsent_required };
  }
  throw new AppClientError("invalid_agreement_state", "the agreement state is not one Clavis answers with");
}

/** Check what `registerAgreement` was given, before anything is sent. */
export function checkAgreementInput(input: {
  useCase: unknown;
  ceremony?: unknown;
  ageBand?: unknown;
  ageMethod?: unknown;
  ageAssertionRequired?: unknown;
}): { useCase: AgreementUseCase; ceremony: AgreementCeremony } {
  if (typeof input.useCase !== "string" || !(AGREEMENT_USE_CASES as readonly string[]).includes(input.useCase)) {
    throw new AppClientError("invalid_agreement", `useCase must be one of ${AGREEMENT_USE_CASES.join(", ")}`);
  }
  const ceremony = input.ceremony ?? "grant";
  if (typeof ceremony !== "string" || !(AGREEMENT_CEREMONIES as readonly string[]).includes(ceremony)) {
    throw new AppClientError("invalid_agreement", "ceremony must be grant, reconsent or withdraw");
  }
  if (input.ageBand !== undefined && (typeof input.ageBand !== "string" || !(AGREEMENT_AGE_BANDS as readonly string[]).includes(input.ageBand))) {
    throw new AppClientError("invalid_agreement", `ageBand must be one of ${AGREEMENT_AGE_BANDS.join(", ")}`);
  }
  if (input.ageAssertionRequired !== undefined && typeof input.ageAssertionRequired !== "boolean") {
    throw new AppClientError("invalid_agreement", "ageAssertionRequired must be a boolean");
  }
  if (input.ageMethod !== undefined) {
    if (typeof input.ageMethod !== "string" || !(AGREEMENT_AGE_METHODS as readonly string[]).includes(input.ageMethod)) {
      throw new AppClientError("invalid_agreement", `ageMethod must be one of ${AGREEMENT_AGE_METHODS.join(", ")}`);
    }
    if (input.ageBand === undefined || input.ageAssertionRequired === true) {
      throw new AppClientError("invalid_agreement", "ageMethod goes with ageBand, and not with ageAssertionRequired");
    }
  }
  return { useCase: input.useCase as AgreementUseCase, ceremony: ceremony as AgreementCeremony };
}
