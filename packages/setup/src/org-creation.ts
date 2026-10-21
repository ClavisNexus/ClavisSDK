import { SetupApiError } from "./org-api.js";
import { LEGAL_ORIGIN, type HumanAction } from "./types.js";

/**
 * What the customer declares and agrees to when an Org is created.
 * Pass it to both org-anchor-plan, which is the challenge, and org-verify-anchor. Declaring the place
 * of incorporation again with incorporation-set takes the same thing.
 */
export type OrgCreationTerms = {
  /** The place of incorporation: `JP`, `GB-EAW`, an EEA country code, or `US-XX`. */
  incorporation?: string;
  /**
   * Set this true only once the customer has agreed to the Customer Terms and the Data Processing
   * Agreement (DPA). Whether to agree is the customer's decision, and the SDK never sets it true by
   * default.
   */
  acceptCustomerTerms?: boolean;
};

type Refusal = { ok: false; error: string; human?: HumanAction };

export const INCORPORATION_HINT = "JP, GB-EAW, an EEA country code (e.g. DE), or US-XX (e.g. US-DE)";

const TERMS_LINKS = `Customer Terms: ${LEGAL_ORIGIN}/en/customer-terms — DPA: ${LEGAL_ORIGIN}/en/dpa.`;

const TERMS_HUMAN: HumanAction = {
  needs_human: "terms",
  message:
    "Creating an Org requires the customer to agree to the Customer Terms and the Data Processing Agreement (DPA). " +
    `${TERMS_LINKS} Only the customer can decide this. If they agree, pass --accept-customer-terms (MCP: accept_customer_terms: true).`,
};

/** A declaration binds to the Customer Terms and DPA versions current at that time. So does declaring again after those versions move. */
export const INCORPORATION_TERMS_HUMAN: HumanAction = {
  needs_human: "terms",
  message:
    "Declaring the place of incorporation binds the Org to the current versions of the Customer Terms and the Data Processing Agreement (DPA). " +
    `${TERMS_LINKS} Only the customer can decide this. If they agree, pass --accept-customer-terms (MCP: accept_customer_terms: true).`,
};

/** As the API does: white space trimmed and the code upper-cased. */
export function normalizeIncorporation(raw: string | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/** Before the passkey, check that the agreement and the place of incorporation are both there. The API checks the shape. */
export function checkOrgCreationTerms(
  terms: OrgCreationTerms,
  human: HumanAction = TERMS_HUMAN,
): { ok: true; incorporation: string } | Refusal {
  if (terms.acceptCustomerTerms !== true) {
    return { ok: false, error: "customer_terms_not_accepted", human };
  }
  const incorporation = normalizeIncorporation(terms.incorporation);
  if (!incorporation) {
    return {
      ok: false,
      error: `incorporation_required — pass --incorporation CODE (MCP: incorporation): ${INCORPORATION_HINT}`,
    };
  }
  return { ok: true, incorporation };
}

export function regionClosedRefusal(incorporation: string): Refusal {
  return {
    ok: false,
    error:
      `region_closed — Clavis is not accepting new Orgs incorporated in ${incorporation} right now. ` +
      "GET /orgs/regions lists the closed places.",
  };
}

/** Turn the API's reason for refusing to create an Org into wording that says what happened. Anything else is null. */
export function orgCreationRefusal(e: unknown, incorporation: string): Refusal | null {
  if (!(e instanceof SetupApiError)) return null;
  if (e.status === 403 && e.code === "REGION_CLOSED") return regionClosedRefusal(incorporation);
  if (e.code === "TERMS_REQUIRED") return { ok: false, error: "customer_terms_not_accepted", human: TERMS_HUMAN };
  if (e.code === "INCORPORATION") return incorporationInvalidRefusal(incorporation);
  return null;
}

export function incorporationInvalidRefusal(incorporation: string): Refusal {
  return {
    ok: false,
    error: `incorporation_invalid — ${incorporation || "(empty)"} is not a place of incorporation Clavis accepts. Use ${INCORPORATION_HINT}.`,
  };
}
