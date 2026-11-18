/**
 * Link your Clavis account (`federation.link`): the app registers a link request for the user who is
 * signed in to it, the user signs the statement `federation.link@1 { app, app_user, nonce, iss }`
 * with a passkey on Connect, and the app reads the app receipt from status. Clavis keeps no table of
 * links; the app keeps `(iss, sub) ↔ appUser` itself.
 *
 * Connect confirms that the person signing is the one who started the link in one of two ways.
 * `return` (the Link your Clavis account button, same tab): the user types nothing; Connect sends the
 * browser back to `returnUrl` with `request_id` and `return_code`, and the link completes only there,
 * in the session that started it. `code` (another device, a QR code, no return): your page shows
 * `displayCode` and the user types it on Connect.
 */
import { AppClientError } from "./errors.js";
import type { ReceiptAnchor, VerifiedReceipt } from "./verify.js";

/** The statement a link signs */
export const FEDERATION_LINK = "federation.link@1";

/** How Connect confirms the link. `return` binds completion to the browser coming back to `returnUrl`; `code` has the user type `displayCode` */
export type LinkConfirm = "code" | "return";

/** The return code Connect puts on `returnUrl` for a `return` link: 43 base64url characters */
const RETURN_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

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
  /** Omitted or `code`: the user types `displayCode` on Connect. For the same-tab button, use `RegisterReturnLinkInput` */
  confirm?: "code";
};

/**
 * A link confirmed by the return (the Link your Clavis account button). Connect asks for no code and
 * sends the user back to `returnUrl` with `request_id` and `return_code`.
 */
export type RegisterReturnLinkInput = Omit<RegisterLinkInput, "confirm" | "returnUrl"> & {
  confirm: "return";
  /** Where the user comes back after linking: https under the app's confirmed host. Complete the link there */
  returnUrl: string;
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
  /** `return` for a link confirmed by the return. Absent, the user typed the display code */
  confirm?: "return";
};

export type RegisterLinkResult = {
  confirm: "code";
  requestId: string;
  /** Where the user goes to link their account on Connect */
  consumeUrl: string;
  /** The confirmation code Connect asks the user to type. Show it on your own page before handing the user over to Connect */
  displayCode: string;
  pending: PendingLink;
};

export type RegisterReturnLinkResult = {
  confirm: "return";
  requestId: string;
  /** Where the button takes the user, in the same tab */
  consumeUrl: string;
  /** Keep it in the session of the user who pressed the button, and only there */
  pending: PendingLink & { confirm: "return" };
};

/** What `completeLink` checks besides the receipt */
export type CompleteLinkOptions = {
  signal?: AbortSignal;
  /**
   * The URL the user came back to (or its query). Required for a `return` link: its `request_id` must
   * be this link's, and its `return_code` is what lets you read the result.
   */
  returned?: string | URL | URLSearchParams;
  /**
   * The user signed in to your app in this browser now. Required for a `return` link, and checked
   * against the user the link was started for whenever it is given.
   */
  appUser?: string;
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
  confirm?: LinkConfirm;
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
  // Absent is the display code; it is never sent as "code"
  if (input.confirm === "return") out.link_confirm = "return";
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
    pending.iss.length > 0 &&
    (pending.confirm === undefined || pending.confirm === "return");
  if (!ok) throw new AppClientError("invalid_status_args", "pending must be the value registerLink returned");
}

function queryOf(returned: CompleteLinkOptions["returned"]): URLSearchParams | null {
  if (returned instanceof URLSearchParams) return returned;
  if (returned instanceof URL) return returned.searchParams;
  if (typeof returned !== "string" || !returned) return null;
  try {
    return new URL(returned).searchParams;
  } catch {
    return new URLSearchParams(returned.startsWith("?") ? returned.slice(1) : returned);
  }
}

/**
 * Before reading status: the user signed in now is the one the link was started for, and for a
 * `return` link, the return is this link's and carries its return code (which is returned).
 */
export function checkLinkReturn(pending: PendingLink, options: CompleteLinkOptions): string | undefined {
  if (options.appUser !== undefined && normalizeAppUser(options.appUser) !== pending.appUser) {
    throw new AppClientError("link_user_mismatch", "the user signed in now is not the user this link was started for");
  }
  if (pending.confirm !== "return") return undefined;
  if (options.appUser === undefined) {
    throw new AppClientError("link_user_mismatch", "a return link needs appUser: the user signed in to your app in this browser now");
  }
  const query = queryOf(options.returned);
  if (!query) throw new AppClientError("link_return_mismatch", "a return link needs returned: the URL the user came back to");
  if (query.get("request_id") !== pending.requestId) {
    throw new AppClientError("link_return_mismatch", "the return is for another link request");
  }
  const code = query.get("return_code") ?? "";
  if (!RETURN_CODE_RE.test(code)) throw new AppClientError("link_return_mismatch", "the return carries no return code");
  return code;
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
