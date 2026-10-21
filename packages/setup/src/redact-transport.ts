const SECRET_KEYS = new Set([
  "operate_private_jwk",
  "OPERATE_PRIVATE_JWK",
  "accessToken",
  "refreshToken",
]);

/** Remove secret values from CLI and MCP responses. File paths stay. */
export function redactForTransport(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => redactForTransport(x));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = "[redacted — use operate_private_jwk_path or env_file on disk]";
      continue;
    }
    if (k === "shell" && typeof v === "string" && v.includes("OPERATE_PRIVATE_JWK=")) {
      out[k] = "[redacted — source env_file instead]";
      continue;
    }
    if (k === "env" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactForTransport(v);
      continue;
    }
    out[k] = redactForTransport(v);
  }
  return out;
}
