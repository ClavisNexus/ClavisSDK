/**
 * The JWT for one request to the ledger API.
 * Authorization: ClavisApp <compact JWT>
 */
import { importJWK, SignJWT, type JWK } from "jose";
import { appIntentRegistrationIssuer } from "../claims.js";
import { sha256, toHex } from "./bytes.js";

export const LEDGER_APP_AUTH_SCHEME = "ClavisApp";
export const LEDGER_APP_REQUEST_AUD = "clavis-ledger";
export const LEDGER_APP_REQUEST_MAX_TTL_SEC = 300;

export async function signLedgerAppRequest(input: {
  appId: string;
  operatePrivateJwk: JWK;
  method: string;
  /** The path and query, for example `/archive/ledger/v1/proof?index=3` */
  pathAndQuery: string;
  body?: Uint8Array;
  nowSec?: number;
  ttlSec?: number;
}): Promise<string> {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(input.ttlSec ?? 60, LEDGER_APP_REQUEST_MAX_TTL_SEC);
  const key = await importJWK(input.operatePrivateJwk, "EdDSA");
  const claims: Record<string, unknown> = {
    app_id: input.appId,
    htm: input.method.toUpperCase(),
    htu: input.pathAndQuery,
  };
  if (input.body && input.body.length > 0) claims.body_sha256 = toHex(await sha256(input.body));
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", ...(input.operatePrivateJwk.kid ? { kid: input.operatePrivateJwk.kid } : {}) })
    .setIssuer(appIntentRegistrationIssuer(input.appId))
    .setAudience(LEDGER_APP_REQUEST_AUD)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(crypto.randomUUID())
    .sign(key);
}
