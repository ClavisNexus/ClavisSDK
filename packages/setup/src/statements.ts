import { bytesToBase64Url, sha256HexUtf8 } from "./base64url.js";
import { canonicalStringify } from "./canonical-json.js";

/**
 * The statement to sign. `type` is the type ID, `<name>@<version>`, and the other fields are the ones
 * that type fixes. Clavis builds the statement it expects from the same material and refuses anything
 * that does not match under JCS (400 `STATEMENT_MISMATCH`). Put the field values in the same form
 * Clavis uses: domains lowercased, regions with no duplicates and in ascending order.
 */
export type Statement = { type: string; [field: string]: unknown };

/** `sha256:` followed by the SHA-256 of the JCS-canonical value, as Base64URL. */
export async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  return `sha256:${bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

/**
 * The digest of a value that names its type, `digestOf({ type, value })`. This is the form a large
 * value takes inside a statement.
 */
export async function valueDigest(type: string, value: unknown): Promise<string> {
  return digestOf({ type, value });
}

/** The digest of the payload of an approval request or an app proposal (`org.payload@1`). The proposer's receipt (`proposer_receipt`) is left out. */
export async function orgPayloadDigest(payload: unknown): Promise<string> {
  let value = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const { proposer_receipt: _receipt, ...rest } = payload as Record<string, unknown>;
    value = rest;
  }
  return valueDigest("org.payload@1", value);
}

/** The DNS anchor, the `receipt` in the published manifest. It comes out the same as `statement` in the response to `POST /orgs/dns/challenge`. */
export function orgAnchorPublishStatement(input: { domain: string; nonce: string; exp: number }): Statement {
  return { type: "org.anchor.publish@1", domain: input.domain.trim().toLowerCase(), nonce: input.nonce, exp: input.exp };
}

export function orgPolicyBootstrapStatement(input: { org: string; domain: string }): Statement {
  return { type: "org.policy.bootstrap@1", org: input.org.trim(), domain: input.domain.trim().toLowerCase() };
}

/** A proposal to register an app. `payload` is the digest of the body with the receipt left out (`orgPayloadDigest`). */
export function orgAppRegisterStatement(input: { org: string; payload: string }): Statement {
  return { type: "org.app.register@1", org: input.org.trim(), payload: input.payload.trim() };
}

export function orgAppVerifyHostStatement(input: { org: string; app: string; host: string; nonce: string }): Statement {
  return {
    type: "org.app.verify_host@1",
    org: input.org.trim(),
    app: input.app.trim(),
    host: input.host.trim().toLowerCase(),
    nonce: input.nonce.trim(),
  };
}

/** The use declaration. `declaration` is the digest of the declaration, or null to remove it. */
export async function orgAppDeclarationStatement(input: {
  org: string;
  app: string;
  declaration: { endUsers: string; uses: { capability: string; operation: string }[] } | null;
}): Promise<Statement> {
  return {
    type: "org.app.declaration@1",
    org: input.org.trim(),
    app: input.app.trim(),
    declaration:
      input.declaration === null
        ? null
        : await valueDigest("app.declaration@1", { endUsers: input.declaration.endUsers, uses: input.declaration.uses }),
  };
}

/** The accepted regions. Null removes the list, so every region Clavis accepts. */
export function orgAppRegionsStatement(input: { org: string; app: string; regions: readonly string[] | null }): Statement {
  return {
    type: "org.app.regions@1",
    org: input.org.trim(),
    app: input.app.trim(),
    regions: input.regions === null ? null : [...new Set(input.regions)].sort(),
  };
}

/** The instruction to erase one person's agreement decisions. `subject` is the person's ID in the org's apps. */
export function orgLexSubjectEraseStatement(input: { org: string; subject: string }): Statement {
  return { type: "org.lex.subject_erase@1", org: input.org.trim(), subject: input.subject.trim() };
}

/** The place-of-incorporation declaration. It binds the current Customer Terms and DPA versions. */
export function orgCardIncorporationStatement(input: {
  org: string;
  code: string;
  customerTerms: string;
  dpa: string;
}): Statement {
  return {
    type: "org.card.incorporation_set@1",
    org: input.org.trim(),
    code: input.code.trim(),
    customer_terms: input.customerTerms.trim(),
    dpa: input.dpa.trim(),
  };
}

/** Checkout for the card. It binds who is billed, and the Customer Terms and DPA versions. */
export function orgCardCheckoutStatement(input: {
  org: string;
  capability: string;
  offer: "meter" | "bundle";
  customerTerms: string;
  dpa: string;
}): Statement {
  return {
    type: "org.card.checkout@1",
    org: input.org.trim(),
    capability: input.capability.trim(),
    offer: input.offer,
    customer_terms: input.customerTerms.trim(),
    dpa: input.dpa.trim(),
  };
}

/** Whether two statements are the same, compared under JCS. */
export function sameStatement(a: unknown, b: unknown): boolean {
  try {
    return canonicalStringify(a) === canonicalStringify(b);
  } catch {
    return false;
  }
}

export async function hashManifestBody(body: unknown): Promise<string> {
  return sha256HexUtf8(canonicalStringify(body));
}

export function buildAnchorTxtRecord(args: { hash: string; nonce: string; exp: number }): string {
  return `v=1;kind=anchor;hash=${args.hash};nonce=${args.nonce};exp=${args.exp}`;
}
