/**
 * Link your Clavis account (`federation.link`): the app registers a link request for the user who is
 * signed in to it, the user signs the statement `federation.link@1 { app, app_user, nonce, iss }`
 * with a passkey on Connect, and the app reads the app receipt from status. Clavis keeps no table of
 * links; the app keeps `(iss, sub) ↔ appUser` itself.
 */
import { AppClientError } from "./errors.js";
import type { ReceiptAnchor, VerifiedReceipt } from "./verify.js";

/** The statement a link signs */
export const FEDERATION_LINK = "federation.link@1";

/** Clavis takes `app_user` of up to 128 UTF-16 code units */
const APP_USER_MAX = 128;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RegisterLinkInput = {
  /**
   * Your own ID for the user who is signed in to your app. The user signs it. Normalised to NFC with
   * the ends trimmed, as Clavis does; at most 128 UTF-16 code units, with no control characters.
   */
  appUser: string;
  /** Where to send the user after linking: https under the app's confirmed host. Omitted, the user ends on Connect */
  returnUrl?: string;
  webhookUrl?: string;
  /** When you already know the user's ID in this app, pass it: only that person can sign the link */
  allowedSub?: string;
  /** The language of Connect's link screen, in order of preference */
  uiLocales?: readonly string[];
  /** How long the request lives, in seconds (60–900). Omitted, it is 120 seconds */
  ttlSeconds?: number;
  signal?: AbortSignal;
};

/** What ties the completion to this link request. Keep it on your server and use it in `completeLink` */
export type PendingLink = {
  requestId: string;
  /** Read status with it. Leave it on your server */
  pollSecret: string;
  /** `appUser` as it is signed (NFC, ends trimmed) */
  appUser: string;
  /** The link's nonce, which the SDK made (a UUID) */
  nonce: string;
  /** The issuer the link names (`https://api.clavis.nexus`) */
  iss: string;
};

export type RegisterLinkResult = {
  requestId: string;
  /** Where the user goes to link their account on Connect */
  consumeUrl: string;
  /** The confirmation code Connect asks the user to enter. Show it on your page, in the session that started the link */
  displayCode: string;
  pending: PendingLink;
};

export type Link = {
  /** The issuer (`https://api.clavis.nexus`) */
  iss: string;
  /** The user's ID in this app: the value to pass as `allowedSub`, and the same `sub` as sign-in */
  sub: string;
  /** Your ID for the user, as signed */
  appUser: string;
  /** When the user signed the link (Unix seconds) */
  linkedAt: number;
  /** The app receipt (`receipt.app@1`), as the string that arrived. The verifier has checked it */
  receipt: string;
  anchor: ReceiptAnchor;
};

/** `appUser` in the form the user signs, or an error before anything is sent */
export function normalizeAppUser(raw: unknown): string {
  const value = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  if (!value || value.length > APP_USER_MAX || CONTROL.test(value) || LONE_SURROGATE.test(value)) {
    throw new AppClientError("invalid_app_user", "appUser must be 1 to 128 characters of text, without control characters");
  }
  return value;
}

/**
 * The claims of a link request. The request carries `link_params` and no payload: Clavis builds the
 * statement `federation.link@1` from them.
 */
export function buildLinkClaims(input: {
  appId: string;
  iat: number;
  exp: number;
  jti: string;
  appUser: string;
  nonce: string;
  iss: string;
  returnUrl?: string;
  webhookUrl?: string;
  allowedSub?: string;
  uiLocales?: readonly string[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    app_id: input.appId,
    intent_type: "generic_sign",
    iat: input.iat,
    exp: input.exp,
    jti: input.jti,
    link_params: { app_id: input.appId, app_user_id: input.appUser, link_nonce: input.nonce, iss: input.iss },
  };
  if (input.allowedSub) out.allowed_sub = input.allowedSub;
  if (input.webhookUrl) out.webhook_url = input.webhookUrl;
  if (input.returnUrl) out.return_url = input.returnUrl;
  if (input.uiLocales && input.uiLocales.length > 0) out.ui_locales = [...input.uiLocales];
  return out;
}

export function assertPendingLink(pending: PendingLink): void {
  const ok =
    pending !== null &&
    typeof pending === "object" &&
    typeof pending.requestId === "string" &&
    pending.requestId.length > 0 &&
    typeof pending.pollSecret === "string" &&
    pending.pollSecret.length > 0 &&
    typeof pending.appUser === "string" &&
    pending.appUser.length > 0 &&
    typeof pending.nonce === "string" &&
    UUID_RE.test(pending.nonce) &&
    typeof pending.iss === "string" &&
    pending.iss.length > 0;
  if (!ok) throw new AppClientError("invalid_status_args", "pending must be the value registerLink returned");
}

/** Read the link from the checked receipt, and check it binds the user, nonce and issuer you asked for */
export function linkFrom(verified: VerifiedReceipt, pending: PendingLink): Link {
  const s = verified.statement;
  if (s.type !== FEDERATION_LINK) throw new AppClientError("link_mismatch", `the completed receipt is not a ${FEDERATION_LINK} signature`);
  if (s.app_user !== pending.appUser || s.nonce !== pending.nonce || s.iss !== pending.iss) {
    throw new AppClientError("link_mismatch", "the signed link does not bind the user, nonce and issuer you asked for");
  }
  return {
    iss: pending.iss,
    sub: verified.envelope.signer,
    appUser: pending.appUser,
    linkedAt: verified.envelope.iat,
    receipt: verified.receipt,
    anchor: verified.anchor,
  };
}
