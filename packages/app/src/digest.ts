import { bytesToBase64Url } from "./base64url.js";
import { canonicalStringify } from "./canonical-json.js";

/** `sha256:` followed by the SHA-256 of the JCS-canonical value, as Base64URL. Use it to compute the hash of terms or of a request yourself */
export async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${bytesToBase64Url(hash)}`;
}
