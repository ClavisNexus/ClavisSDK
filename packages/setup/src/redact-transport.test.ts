import { describe, expect, it } from "vitest";
import { redactForTransport } from "./redact-transport.js";

describe("redactForTransport", () => {
  it("redacts nested secrets", () => {
    const out = redactForTransport({
      ok: true,
      data: { operate_private_jwk: '{"kty":"EC"}', app_id: "a" },
    }) as { data: { operate_private_jwk: string; app_id: string } };
    expect(out.data.app_id).toBe("a");
    expect(out.data.operate_private_jwk).toContain("redacted");
  });
});
