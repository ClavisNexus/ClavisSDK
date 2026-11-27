export const REGISTER_TTL_SEC = 120;
/** The range of request lifetimes Clavis accepts, in seconds. The cap is narrowed further by the setting on the app in developers. */
export const REGISTER_TTL_MIN_SEC = 60;
export const REGISTER_TTL_MAX_SEC = 900;
export const APP_INTENT_REGISTRATION_AUD = "app-intent-registration";

export function appIntentRegistrationIssuer(appId: string): string {
  return `app:${appId}`;
}

/**
 * The claims of a signature request. The payload holds `message_digest` and an optional
 * `display_hint`, and nothing else: Clavis refuses any other field. What is signed (the statement
 * `app.sign@1`, or `app.sign.on_behalf@1` on behalf of an organisation) is what Clavis builds from
 * the request.
 */
export function buildGenericSignClaims(input: {
  appId: string;
  iat: number;
  exp: number;
  jti: string;
  messageDigest: string;
  displayHint?: string;
  /** Where to send the user after signing. Omitted, the user ends on Connect's completion screen */
  returnUrl?: string;
  webhookUrl?: string;
  /** The user's ID in this app (the same value as the OIDC `sub`). Only to name one signer */
  allowedSub?: string;
  uiLocales?: readonly string[];
  /** When asking for a signature on behalf of an organisation, that organisation's domain, normalised */
  onBehalfDomain?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    message_digest: input.messageDigest,
  };
  if (input.displayHint) payload.display_hint = input.displayHint;

  const out: Record<string, unknown> = {
    app_id: input.appId,
    intent_type: "generic_sign",
    iat: input.iat,
    exp: input.exp,
    jti: input.jti,
    payload,
  };
  if (input.allowedSub) out.allowed_sub = input.allowedSub;
  if (input.webhookUrl) out.webhook_url = input.webhookUrl;
  if (input.returnUrl) out.return_url = input.returnUrl;
  if (input.uiLocales && input.uiLocales.length > 0) out.ui_locales = [...input.uiLocales];
  if (input.onBehalfDomain) out.on_behalf = { domain: input.onBehalfDomain };
  return out;
}

/**
 * The claims of a delegation request. The payload holds the terms and nothing else: Clavis refuses
 * any other field. A delegation names one signer, so `allowed_sub` is required. What is signed (the
 * statement `mandate.grant@1`) is what Clavis builds from the delegation's ID and the hash of the
 * terms.
 */
export function buildMandateClaims(input: {
  appId: string;
  iat: number;
  exp: number;
  jti: string;
  /** The normalised terms (`mandate.terms@1`) */
  terms: Record<string, unknown>;
  allowedSub: string;
  returnUrl?: string;
  webhookUrl?: string;
  uiLocales?: readonly string[];
  /** When asking for a delegation on behalf of an organisation, that organisation's domain, normalised */
  onBehalfDomain?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    app_id: input.appId,
    intent_type: "mandate",
    iat: input.iat,
    exp: input.exp,
    jti: input.jti,
    payload: { terms: input.terms },
    allowed_sub: input.allowedSub,
  };
  if (input.webhookUrl) out.webhook_url = input.webhookUrl;
  if (input.returnUrl) out.return_url = input.returnUrl;
  if (input.uiLocales && input.uiLocales.length > 0) out.ui_locales = [...input.uiLocales];
  if (input.onBehalfDomain) out.on_behalf = { domain: input.onBehalfDomain };
  return out;
}

/** The registration claims of an agreement (`intent_type: "agreement"`). Clavis builds what the user is shown from the app's profile. */
export function buildAgreementClaims(input: {
  appId: string;
  iat: number;
  exp: number;
  jti: string;
  useCase: string;
  ceremony: string;
  ageBand?: string;
  ageMethod?: string;
  ageAssertionRequired?: boolean;
  allowedSub?: string;
  returnUrl?: string;
  webhookUrl?: string;
  uiLocales?: readonly string[];
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { use_case: input.useCase };
  // Omitted is a grant, so only the other ceremonies are sent
  if (input.ceremony !== "grant") payload.ceremony = input.ceremony;
  if (input.ageBand !== undefined) payload.age_band = input.ageBand;
  if (input.ageMethod !== undefined) payload.age_method = input.ageMethod;
  if (input.ageAssertionRequired !== undefined) payload.age_assertion_required = input.ageAssertionRequired;
  const out: Record<string, unknown> = {
    app_id: input.appId,
    intent_type: "agreement",
    iat: input.iat,
    exp: input.exp,
    jti: input.jti,
    payload,
  };
  if (input.allowedSub) out.allowed_sub = input.allowedSub;
  if (input.webhookUrl) out.webhook_url = input.webhookUrl;
  if (input.returnUrl) out.return_url = input.returnUrl;
  if (input.uiLocales && input.uiLocales.length > 0) out.ui_locales = [...input.uiLocales];
  return out;
}
