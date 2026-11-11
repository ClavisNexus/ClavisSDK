/**
 * `Authorization: ClavisEntity <JWS>` for a relay request.
 * The protected header is `{ alg, typ: "clavis-entity+jws", kid }`. `alg` is `EdDSA` or `ES256`.
 * Claims are `entity`, `htm`, `htu`, `body_sha256` (only when the body is non-empty), `iat`, `exp`, `jti`.
 * Header and claims are RFC 8785 canonical JSON. The signature is raw r‖s (64 bytes); an ES256 `s` is at most half the P-256 order.
 */
import { importJWK, type JWK } from "jose";
import { bytesToBase64Url, base64UrlToBytes } from "./base64url.js";
import { canonicalStringify } from "./canonical-json.js";
import { digestOf } from "./digest.js";
import { AppClientError } from "./errors.js";
import { bufferSource, sha256, toHex, utf8 } from "./ledger/bytes.js";

export const ENTITY_AUTH_SCHEME = "ClavisEntity";
export const ENTITY_JWS_TYP = "clavis-entity+jws";
/** `exp - iat` for a request this module signs. */
export const ENTITY_JWS_LIFETIME_SEC = 60;

const DIGEST_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const JTI_RE = /^[A-Za-z0-9_-]{22,64}$/;

const P256_N = bytes32("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_N = bytes32("7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8");

export type EntityJwsAlg = "EdDSA" | "ES256";

export type EntityRequestKey = {
  alg: EntityJwsAlg;
  /** Digest of the canonical public JWK. */
  kid: string;
  sign: (input: Uint8Array) => Promise<Uint8Array>;
};

export function isSha256Digest(value: string): boolean {
  return DIGEST_RE.test(value);
}

/** Lowercase the scheme and host, and drop a default port. The path and query stay as serialized. */
export function normalizeHtu(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("htu_invalid");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "") {
    throw new Error("htu_invalid");
  }
  u.hash = "";
  return u.href;
}

export function normalizeHtm(method: string): string {
  const upper = method.replace(/[a-z]/g, (c) => c.toUpperCase());
  return upper === "DELETE" || upper === "GET" || upper === "HEAD" || upper === "OPTIONS" || upper === "POST" || upper === "PUT"
    ? upper
    : method;
}

export async function signEntityRequest(input: {
  key: EntityRequestKey;
  entity: string;
  method: string;
  url: string;
  /** Exact body bytes. Omitted, null, or empty: the claims have no `body_sha256`. */
  body?: Uint8Array | null;
  iat?: number;
  lifetime?: number;
  jti?: string;
}): Promise<string> {
  if (!isSha256Digest(input.entity)) throw new Error("entity_request_entity_invalid");
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const lifetime = input.lifetime ?? ENTITY_JWS_LIFETIME_SEC;
  if (!Number.isSafeInteger(iat) || iat < 0 || !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > ENTITY_JWS_LIFETIME_SEC) {
    throw new Error("entity_request_time_invalid");
  }
  const jti = input.jti ?? newJti();
  if (!isJti(jti)) throw new Error("entity_request_jti_invalid");
  const claims: Record<string, unknown> = {
    entity: input.entity,
    exp: iat + lifetime,
    htm: normalizeHtm(input.method),
    htu: normalizeHtu(input.url),
    iat,
    jti,
  };
  const body = input.body && input.body.length > 0 ? input.body : null;
  if (body) claims.body_sha256 = toHex(await sha256(body));
  const header = { alg: input.key.alg, kid: input.key.kid, typ: ENTITY_JWS_TYP };
  const signingInput = `${bytesToBase64Url(utf8(canonicalStringify(header)))}.${bytesToBase64Url(utf8(canonicalStringify(claims)))}`;
  const sig = await input.key.sign(utf8(signingInput));
  if (sig.length !== 64) throw new Error("entity_request_signature_invalid");
  return `${signingInput}.${bytesToBase64Url(input.key.alg === "ES256" ? toLowS(sig) : sig)}`;
}

export async function loadEntityRequestKey(raw: string | Record<string, unknown>): Promise<EntityRequestKey> {
  const json = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
  if (!json) throw new AppClientError("invalid_request_jwk", "requestPrivateJwk required");
  let jwk: JWK;
  try {
    jwk = JSON.parse(json) as JWK;
  } catch {
    throw new AppClientError("invalid_request_jwk", "requestPrivateJwk must be JSON");
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    const x = coordinate(jwk.x);
    if (!x || typeof jwk.d !== "string" || jwk.d.length === 0) {
      throw new AppClientError("invalid_request_jwk", "requestPrivateJwk must be an Ed25519 private JWK");
    }
    const kid = await digestOf({ crv: "Ed25519", kty: "OKP", x });
    const key = await importPrivateKey({ ...jwk, alg: "EdDSA" }, "EdDSA");
    return {
      alg: "EdDSA",
      kid,
      sign: async (input) => {
        const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bufferSource(input)));
        if (sig.length !== 64) throw new Error("entity_request_signature_invalid");
        return sig;
      },
    };
  }
  if (jwk.kty === "EC" && jwk.crv === "P-256") {
    const x = coordinate(jwk.x);
    const y = coordinate(jwk.y);
    if (!x || !y || typeof jwk.d !== "string" || jwk.d.length === 0) {
      throw new AppClientError("invalid_request_jwk", "requestPrivateJwk must be a P-256 private JWK");
    }
    const kid = await digestOf({ crv: "P-256", kty: "EC", x, y });
    const key = await importPrivateKey({ ...jwk, alg: "ES256" }, "ES256");
    return {
      alg: "ES256",
      kid,
      sign: async (input) => toLowS(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bufferSource(input)))),
    };
  }
  throw new AppClientError("invalid_request_jwk", "requestPrivateJwk must be Ed25519 (EdDSA) or P-256 (ES256)");
}

async function importPrivateKey(jwk: JWK, alg: EntityJwsAlg): Promise<CryptoKey> {
  try {
    const key = await importJWK(jwk, alg);
    if (!(key instanceof CryptoKey)) throw new Error("not a CryptoKey");
    return key;
  } catch (e) {
    if (e instanceof AppClientError) throw e;
    throw new AppClientError("invalid_request_jwk", "requestPrivateJwk could not be imported", undefined, { cause: e });
  }
}

function newJti(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function isJti(value: string): boolean {
  if (!JTI_RE.test(value)) return false;
  try {
    const bytes = base64UrlToBytes(value);
    return bytes.length > 0 && bytesToBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

function coordinate(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = base64UrlToBytes(value);
    return bytes.length === 32 && bytesToBase64Url(bytes) === value ? value : null;
  } catch {
    return null;
  }
}

function bytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

function negateScalar(s: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  let borrow = 0;
  for (let i = 31; i >= 0; i--) {
    const d = P256_N[i]! - s[i]! - borrow;
    borrow = d < 0 ? 1 : 0;
    out[i] = d + borrow * 256;
  }
  return out;
}

/** Replace `s` with `n - s` when `s` is above half the P-256 order. */
function toLowS(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error("entity_request_signature_invalid");
  const s = sig.subarray(32);
  if (compareBytes(s, P256_HALF_N) <= 0) return sig;
  const out = new Uint8Array(64);
  out.set(sig.subarray(0, 32), 0);
  out.set(negateScalar(s), 32);
  return out;
}
