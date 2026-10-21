import { importJWK, jwtVerify, type JWK } from "jose";

/** The session key in the aggregate JWKS. A slot is looked up by the field ending in `-slot`; the kid string is never taken apart. */
const SESSION_SLOT = "wauthn-auth-jwt";
const SLOT_FIELD = /^[a-z][a-z0-9]{1,31}-slot$/;
const JWK_MEMBERS = ["kty", "crv", "x", "y", "kid", "alg"] as const;

export type VerifiedDevelopersAccess = {
  sub: string;
  /** The JWT's `exp` (Unix seconds) */
  expiresAt: number;
};

/** Look up the key for a kid in the aggregate JWKS. Null unless it is a key in the session slot */
async function sessionKey(origin: string, kid: string): Promise<CryptoKey | Uint8Array | null> {
  const res = await fetch(`${origin}/.well-known/jwks.json`, { redirect: "error", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const doc = (await res.json()) as { keys?: Record<string, unknown>[] };
  const key = (doc.keys ?? []).find((k) => k && k.kid === kid);
  if (!key) return null;
  const slot = Object.entries(key).find(([name]) => SLOT_FIELD.test(name))?.[1];
  if (slot !== SESSION_SLOT) return null;
  const jwk: Record<string, unknown> = {};
  for (const m of JWK_MEMBERS) if (key[m] !== undefined) jwk[m] = key[m];
  return importJWK(jwk as JWK, "ES256");
}

/**
 * Check an access JWT from developers.
 * It requires the signature, ES256, a key in the session slot, `iss` and `aud` (the API origin),
 * `exp`, `sub`, and `tk=access`.
 */
export async function verifyDevelopersAccessToken(
  accessToken: string,
  apiOrigin: string,
): Promise<VerifiedDevelopersAccess> {
  const origin = new URL(apiOrigin).origin;
  let refused = false;
  const { payload } = await jwtVerify(
    accessToken,
    async (header) => {
      const key = typeof header.kid === "string" ? await sessionKey(origin, header.kid) : null;
      if (!key) {
        refused = true;
        throw new Error("invalid_access_token_kid");
      }
      return key;
    },
    { algorithms: ["ES256"], issuer: origin, audience: origin, requiredClaims: ["exp", "iss", "aud", "sub"] },
  ).catch((e: unknown) => {
    if (refused) throw new Error("invalid_access_token_kid");
    throw e;
  });
  if (payload.tk !== "access") throw new Error("invalid_access_token_kind");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("invalid_access_token_sub");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new Error("invalid_access_token_exp");
  return { sub: payload.sub, expiresAt: payload.exp };
}
