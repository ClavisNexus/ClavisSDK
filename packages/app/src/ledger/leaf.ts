/**
 * The ledger v1 leaf. It carries no time, no subject, no kind and no app identifier.
 * leaf_hash = SHA-256( 0x00 ‖ canonical({ v: 1, c, slot? }) )
 */
import { canonicalStringify } from "../canonical-json.js";
import { concatBytes, HEX64, sha256, toHex, utf8 } from "./bytes.js";

export type LedgerLeaf = { v: 1; c: string; slot?: string };

export function parseLedgerLeaf(o: unknown): LedgerLeaf | null {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "v" && k !== "c" && k !== "slot") return null;
  if (r.v !== 1 || typeof r.c !== "string" || !HEX64.test(r.c)) return null;
  if (r.slot !== undefined && (typeof r.slot !== "string" || !HEX64.test(r.slot))) return null;
  return r.slot === undefined ? { v: 1, c: r.c } : { v: 1, c: r.c, slot: r.slot };
}

export function encodeLedgerLeaf(leaf: LedgerLeaf): Uint8Array {
  const o: Record<string, unknown> = { v: 1, c: leaf.c };
  if (leaf.slot !== undefined) o.slot = leaf.slot;
  return utf8(canonicalStringify(o));
}

/** The RFC 6962 leaf hash: SHA-256 over the bytes with `0x00` prefixed */
export async function ledgerLeafHash(leaf: LedgerLeaf): Promise<Uint8Array> {
  return sha256(concatBytes(new Uint8Array([0]), encodeLedgerLeaf(leaf)));
}

export async function ledgerLeafHashHex(leaf: LedgerLeaf): Promise<string> {
  return toHex(await ledgerLeafHash(leaf));
}
