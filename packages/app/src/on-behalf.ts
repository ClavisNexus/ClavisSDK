/**
 * Signatures and delegations made on behalf of an organisation.
 *
 * - The statements `app.sign.on_behalf@1` and `mandate.grant.on_behalf@1` say that the person signed
 *   on behalf of an organisation. `org` is that organisation's ID in Clavis, and `domain` is the
 *   domain it confirmed through DNS. A receipt means Clavis confirmed, at completion, that the person
 *   who signed was designated as a signer for that organisation.
 * - A delegation granted on behalf of an organisation closes when the granter's signer designation
 *   ends (`mandate.close@1`, reason `signer_designation_ended`). Uses stay `mandate.use@1`, and
 *   Clavis checks the designation again at each use before it countersigns.
 */
export const APP_SIGN_ON_BEHALF = "app.sign.on_behalf@1";
export { MANDATE_GRANT_ON_BEHALF } from "./mandate.js";

/** The organisation named. `org` is its ID in Clavis, and `domain` is the domain it confirmed through DNS, lowercased */
export type OnBehalf = { org: string; domain: string };

const ORG_ID = /^[a-z]{2}[1-9][0-9]{0,2}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isDomain(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 253) return false;
  const parts = v.split(".");
  return parts.length >= 2 && parts.every((p) => LABEL.test(p));
}

/**
 * Put the domain for a request in the form Clavis accepts: white space trimmed, lowercased, and a
 * trailing dot dropped. A domain of the wrong shape is null. Pass internationalised domains in
 * Punycode (`xn--`).
 */
export function normalizeOnBehalfDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  return isDomain(domain) ? domain : null;
}

/** When the statement the verifier returned is one made on behalf of an organisation, return that organisation; otherwise null */
export function readOnBehalf(statement: { type: string } & Record<string, unknown>): OnBehalf | null {
  if (statement.type !== APP_SIGN_ON_BEHALF && statement.type !== "mandate.grant.on_behalf@1") return null;
  if (typeof statement.org !== "string" || !ORG_ID.test(statement.org) || !isDomain(statement.domain)) return null;
  return { org: statement.org, domain: statement.domain };
}
