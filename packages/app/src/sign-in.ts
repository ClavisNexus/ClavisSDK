/**
 * Sign in with Clavis: the authorization code flow with PKCE against Clavis's OIDC endpoints on the
 * API host, run from the app's server. The values that tie the return to the start (`state`, `nonce`
 * and the PKCE verifier) are what the caller keeps on its server; only `state`, `nonce` and the
 * challenge go into the URL.
 *
 * The id_token is checked with a sign-in key in the aggregate JWKS, which
 * the verifier checks against `trustRoot`, the same trust root receipts use. Clavis's refusals come
 * back as two codes: `declined` (the user stopped, or did not get through) and `unavailable`
 * (sign-in is not open to this app now, and refusals of the code exchange and the refresh).
 */
import { decodeProtectedHeader, errors as joseErrors, importJWK, jwtVerify, type JWTPayload } from "jose";
import { bytesToBase64Url } from "./base64url.js";
import { AppClientError } from "./errors.js";

/** Trusted JWKS slots during the transition to the dedicated ID token key. */
export const SIGN_IN_KEY_SLOTS = ["oidc-id-token", "wauthn-auth-jwt"] as const;

/** Scopes to ask for besides `openid`, which is always asked for */
export const SIGN_IN_SCOPES = ["profile", "org.role"] as const;

export type SignInScope = (typeof SIGN_IN_SCOPES)[number];

/** How far apart the clocks may be, in seconds */
const CLOCK_TOLERANCE_SEC = 60;
/** An id_token from the token endpoint was issued just now; one older than this is not taken */
const ID_TOKEN_MAX_AGE_SEC = 300;
/** The user's ID in this app, in the form Clavis issues it */
const SUBJECT_RE = /^[A-Za-z0-9._~:@+=/-]{1,200}$/;
/** `state`, `nonce` and the PKCE verifier: 32 random bytes as Base64URL */
const RANDOM_RE = /^[A-Za-z0-9_-]{43}$/;

export type BeginSignInInput = {
  /**
   * Where Clavis sends the user back: one of the app's redirect paths in developers, as an https URL
   * under the app's host (http only on a loopback host). Pass the same URL that path is registered as.
   */
  redirectUri: string;
  /** What to ask for besides the user's ID in this app: `profile` (the display name, `name`) and `org.role` (read with `orgMembership`) */
  scope?: readonly SignInScope[];
  /**
   * The language of Clavis's sign-in screen. BCP 47 language tags in order of preference, the same list
   * as `uiLocales` elsewhere. Omitted, the user's choice and the browser's language decide.
   */
  uiLocales?: readonly string[];
};

/**
 * What ties the return to this start. Keep it on your server (the session, a key-value store), use it
 * once in `completeSignIn` and then delete it. Do not put it in a URL or a cookie the browser can read.
 */
export type PendingSignIn = {
  state: string;
  nonce: string;
  /** The PKCE code verifier. It never leaves your server until the code exchange */
  codeVerifier: string;
  redirectUri: string;
  /** The scope asked for, space-separated (`openid` first) */
  scope: string;
};

export type BeginSignInResult = {
  /** The authorization URL on the API host. Send the user there (from your button, a 302, or `location.assign`) */
  url: string;
  pending: PendingSignIn;
};

export type SignInTokens = {
  /** The access token. It reads `orgMembership` when `org.role` was asked for */
  accessToken: string;
  /** The refresh token, for `refreshSignIn`. A refresh turns it over: keep the new one */
  refreshToken?: string;
  /** The id_token the SDK checked, as it arrived */
  idToken: string;
  /** When the access token expires (Unix seconds) */
  expiresAt: number;
  /** The scope granted */
  scope: string[];
};

export type SignIn = {
  /** The issuer (`https://api.clavis.nexus`). Key your accounts by `iss` and `sub` together */
  iss: string;
  /**
   * The user's ID in this app. It differs from app to app. It is the value to pass as `allowedSub`
   * when you register a signature request or a delegation, and the `sub` a completion returns.
   */
  sub: string;
  /** The display name, when `profile` was granted and the user set one */
  name?: string;
  tokens: SignInTokens;
};

export type OrgMembership = {
  /** The user's ID in this app */
  sub: string;
  appId: string;
  /** The Org that owns this app */
  orgId: string;
  /** The user's role in that Org, or null when the user is not a member */
  orgRole: "owner" | "admin" | "member" | null;
};

function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(hash));
}

/** An absolute https URL (http only on a loopback host), without credentials or a fragment */
export function checkedReturnUrl(raw: unknown, field: string): string {
  let url: URL;
  try {
    if (typeof raw !== "string") throw new TypeError(field);
    url = new URL(raw);
  } catch {
    throw new AppClientError("invalid_sign_in_args", `${field} must be an absolute URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AppClientError("invalid_sign_in_args", `${field} must be https`);
  }
  if (url.username || url.password || url.hash) {
    throw new AppClientError("invalid_sign_in_args", `${field} must not carry credentials or a fragment`);
  }
  return raw;
}

function checkedScope(scope: readonly SignInScope[] | undefined): string {
  const extra = scope ?? [];
  if (!Array.isArray(extra) || extra.some((s) => !(SIGN_IN_SCOPES as readonly string[]).includes(s))) {
    throw new AppClientError("invalid_sign_in_args", `scope may only list ${SIGN_IN_SCOPES.join(", ")}`);
  }
  return ["openid", ...SIGN_IN_SCOPES.filter((s) => extra.includes(s))].join(" ");
}

/** Make the start of a sign-in: the authorization URL, and what to keep until the return */
export async function buildSignInStart(
  apiOrigin: string,
  appId: string,
  input: BeginSignInInput,
  uiLocales: string[] | undefined,
): Promise<BeginSignInResult> {
  const redirectUri = checkedReturnUrl(input?.redirectUri, "redirectUri");
  const scope = checkedScope(input.scope);
  const pending: PendingSignIn = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(), redirectUri, scope };
  const q = new URLSearchParams({
    response_type: "code",
    client_id: appId,
    redirect_uri: redirectUri,
    scope,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await pkceChallenge(pending.codeVerifier),
    code_challenge_method: "S256",
  });
  if (uiLocales) q.set("ui_locales", uiLocales.join(" "));
  return { url: `${apiOrigin}/oauth/authorize?${q.toString()}`, pending };
}

export function assertPendingSignIn(pending: PendingSignIn): void {
  const ok =
    pending !== null &&
    typeof pending === "object" &&
    typeof pending.state === "string" &&
    RANDOM_RE.test(pending.state) &&
    typeof pending.nonce === "string" &&
    RANDOM_RE.test(pending.nonce) &&
    typeof pending.codeVerifier === "string" &&
    RANDOM_RE.test(pending.codeVerifier) &&
    typeof pending.redirectUri === "string" &&
    typeof pending.scope === "string" &&
    pending.scope.split(" ")[0] === "openid";
  if (!ok) throw new AppClientError("invalid_sign_in_args", "pending must be the value beginSignIn returned");
  checkedReturnUrl(pending.redirectUri, "pending.redirectUri");
}

/** The query of the return: a URL, a query string, or its parameters */
function callbackParams(callback: string | URL | URLSearchParams): URLSearchParams {
  if (callback instanceof URLSearchParams) return callback;
  if (callback instanceof URL) return callback.searchParams;
  if (typeof callback !== "string") throw new AppClientError("invalid_callback", "callback must be the return URL or its query");
  try {
    return new URL(callback).searchParams;
  } catch {
    return new URLSearchParams(callback.startsWith("?") ? callback.slice(1) : callback);
  }
}

/**
 * Read the return against what was kept. The `state` is checked first: an answer that does not carry
 * the kept `state` is not read further, whatever it says. Returns the authorization code.
 */
export function readSignInCallback(callback: string | URL | URLSearchParams, pending: PendingSignIn, issuer: string): string {
  const params = callbackParams(callback);
  const state = params.get("state");
  if (!state || state !== pending.state) {
    throw new AppClientError("state_mismatch", "the return does not carry the state this sign-in started with");
  }
  const iss = params.get("iss");
  if (iss !== null && iss !== issuer) throw new AppClientError("invalid_callback", "the return names another issuer");
  const error = params.get("error");
  if (error !== null) {
    if (error === "access_denied") {
      throw new AppClientError("declined", "the user did not sign in (access_denied)", undefined, { apiError: error });
    }
    throw new AppClientError("unavailable", `sign-in is not available for this app (${error})`, undefined, { apiError: error });
  }
  const code = params.get("code");
  if (!code) throw new AppClientError("invalid_callback", "the return carries neither code nor error");
  return code;
}

/** The token endpoint's answer, read for shape. The id_token is checked separately */
export function parseTokenResponse(body: unknown, nowSec: number): SignInTokens {
  const r = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const str = (k: string) => (r && typeof r[k] === "string" && (r[k] as string).length > 0 ? (r[k] as string) : null);
  const accessToken = str("access_token");
  const idToken = str("id_token");
  const tokenType = str("token_type");
  const expiresIn = r?.expires_in;
  if (!accessToken || !idToken || tokenType?.toLowerCase() !== "bearer") {
    throw new AppClientError("invalid_token_response", "the token response lacks access_token, id_token or a Bearer token_type");
  }
  if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw new AppClientError("invalid_token_response", "the token response lacks expires_in");
  }
  if (r!.refresh_token !== undefined && str("refresh_token") === null) {
    throw new AppClientError("invalid_token_response", "refresh_token is not a string");
  }
  const refreshToken = str("refresh_token");
  const scope = (str("scope") ?? "openid").split(" ").filter(Boolean);
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), idToken, expiresAt: nowSec + expiresIn, scope };
}

export type IdTokenExpect = {
  issuer: string;
  appId: string;
  /** The nonce the sign-in started with. A refresh has none */
  nonce?: string;
  /** The `sub` the token must name (a refresh names the same user) */
  sub?: string;
  /** The access token issued with it, for `at_hash` */
  accessToken: string;
  /** The sign-in key for `kid`, from the aggregate JWKS that chains to the trust root, or null */
  key: (kid: string) => Promise<JsonWebKey | null>;
};

function invalid(reason: string, cause?: unknown): AppClientError {
  return new AppClientError("id_token_invalid", `the id_token was refused (${reason})`, undefined, cause === undefined ? undefined : { cause });
}

/** The reason jose gave, in a word */
function joseReason(e: unknown): string {
  if (e instanceof joseErrors.JWTExpired || e instanceof joseErrors.JWTClaimValidationFailed) return e.claim;
  if (e instanceof joseErrors.JWSSignatureVerificationFailed) return "signature";
  return "malformed";
}

/** Check the id_token: ES256 under a sign-in key, `iss`, `aud` (the app's ID alone), `exp`, `iat`, `nonce`, `sub` and `at_hash` */
export async function verifyIdToken(idToken: string, expect: IdTokenExpect): Promise<{ sub: string; name?: string }> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(idToken);
  } catch (e) {
    throw invalid("malformed", e);
  }
  if (header.alg !== "ES256") throw invalid("alg");
  if (typeof header.kid !== "string" || header.kid.length === 0) throw invalid("kid");
  const jwk = await expect.key(header.kid);
  if (!jwk) throw invalid("kid");
  let payload: JWTPayload;
  try {
    const key = await importJWK({ ...jwk, alg: "ES256" }, "ES256");
    payload = (
      await jwtVerify(idToken, key, {
        algorithms: ["ES256"],
        issuer: expect.issuer,
        audience: expect.appId,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        maxTokenAge: ID_TOKEN_MAX_AGE_SEC,
        requiredClaims: ["iss", "aud", "sub", "iat", "exp"],
      })
    ).payload;
  } catch (e) {
    throw invalid(joseReason(e), e);
  }
  const aud = payload.aud;
  if (!(aud === expect.appId || (Array.isArray(aud) && aud.length === 1 && aud[0] === expect.appId))) throw invalid("aud");
  if (payload.azp !== undefined && payload.azp !== expect.appId) throw invalid("azp");
  if (expect.nonce !== undefined && payload.nonce !== expect.nonce) throw invalid("nonce");
  const sub = payload.sub;
  if (typeof sub !== "string" || !SUBJECT_RE.test(sub)) throw invalid("sub");
  if (expect.sub !== undefined && sub !== expect.sub) throw invalid("sub");
  if (payload.at_hash !== undefined) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expect.accessToken)));
    if (payload.at_hash !== bytesToBase64Url(hash.subarray(0, 16))) throw invalid("at_hash");
  }
  const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : undefined;
  return { sub, ...(name ? { name } : {}) };
}

/** Read the Org membership answer, and check it is for this app */
export function parseOrgMembership(body: unknown, appId: string): OrgMembership {
  const r = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const role = r?.org_role;
  if (
    !r ||
    typeof r.sub !== "string" ||
    !SUBJECT_RE.test(r.sub) ||
    typeof r.org_id !== "string" ||
    r.org_id.length === 0 ||
    !(role === null || role === "owner" || role === "admin" || role === "member")
  ) {
    throw new AppClientError("invalid_org_membership", "the org membership answer has the wrong shape");
  }
  if (r.app_id !== appId) throw new AppClientError("invalid_org_membership", "the org membership answer is for another app");
  return { sub: r.sub, appId, orgId: r.org_id, orgRole: role };
}
