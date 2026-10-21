/**
 * The ledger v1 commitment. The app computes it in the SDK, and Clavis receives neither the salt nor
 * the record.
 *
 * c = SHA-256( "clavis.commit.v1" ‖ salt(32B) ‖ canonical(record) )
 */
import { bytesToBase64Url, base64UrlToBytes } from "../base64url.js";
import { canonicalStringify } from "../canonical-json.js";
import { bufferSource, concatBytes, sha256, toHex, utf8 } from "./bytes.js";

export const LEDGER_COMMIT_DOMAIN = "clavis.commit.v1";
export const LEDGER_SALT_BYTES = 32;

/** The opening. The app or the Vault keeps it; erase it and the leaf binds to nothing. */
export type LedgerOpening = {
  /** 32 random bytes, as base64url */
  salt: string;
  record: unknown;
};

/** The salt is always generated here from a CSPRNG: the app never chooses it. */
export function createLedgerOpening(record: unknown): LedgerOpening {
  canonicalStringify(record); // Refuse a value that cannot be canonicalised, before anything else
  const salt = new Uint8Array(LEDGER_SALT_BYTES);
  crypto.getRandomValues(salt);
  return { salt: bytesToBase64Url(salt), record };
}

export async function computeLedgerCommitment(opening: LedgerOpening): Promise<string> {
  const salt = base64UrlToBytes(opening.salt);
  if (salt.length !== LEDGER_SALT_BYTES) throw new Error("ledger_salt_length");
  const body = utf8(canonicalStringify(opening.record));
  return toHex(await sha256(concatBytes(utf8(LEDGER_COMMIT_DOMAIN), salt, body)));
}

/**
 * The slot. Without the app's secret `key`, Clavis cannot tell it from random bytes.
 * To transfer ownership, use `ledgerAssetVersionSlotLabel(asset_id, version)` as the label.
 */
export async function computeLedgerSlot(key: Uint8Array, label: string): Promise<string> {
  if (key.length < 32) throw new Error("ledger_slot_key_too_short");
  const k = await crypto.subtle.importKey("raw", bufferSource(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, bufferSource(utf8(label)))));
}

export function ledgerAssetVersionSlotLabel(assetId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("ledger_slot_version");
  return `asset:${assetId}:v${version}`;
}
