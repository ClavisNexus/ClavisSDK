export function canonicalStringify(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(v: unknown): string {
  if (v === undefined) throw new Error("canonical_json_undefined");
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("canonical_json_non_finite");
  if (typeof v === "bigint") throw new Error("canonical_json_bigint");
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
