import { describe, expect, it } from "vitest";
import { canonicalStringify } from "./canonical-json.js";
import { receiptFromCeremonyPayload } from "./ceremony.js";
import {
  buildAnchorTxtRecord,
  digestOf,
  orgPayloadDigest,
  orgAnchorPublishStatement,
  orgAppDeclarationStatement,
  orgAppRegionsStatement,
  orgAppRegisterStatement,
  sameStatement,
} from "./statements.js";

const ORG = "550e8400-e29b-41d4-a716-446655440000";

describe("statements", () => {
  it("canonical stringify sorts keys", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("normalizes the anchor domain the way Clavis does", () => {
    const a = orgAnchorPublishStatement({ domain: "Example.COM ", nonce: "n", exp: 1 });
    expect(a).toEqual({ type: "org.anchor.publish@1", domain: "example.com", nonce: "n", exp: 1 });
    expect(sameStatement(a, { exp: 1, nonce: "n", domain: "example.com", type: "org.anchor.publish@1" })).toBe(true);
    expect(sameStatement(a, { ...a, exp: 2 })).toBe(false);
  });

  it("payload digest names its type and strips the proposer receipt", async () => {
    const a = await orgPayloadDigest({ v: 1, host: "a.example.com" });
    const b = await orgPayloadDigest({ v: 1, host: "a.example.com", proposer_receipt: { type: "receipt@1" } });
    expect(a).toBe(b);
    expect(a).toBe(await digestOf({ type: "org.payload@1", value: { v: 1, host: "a.example.com" } }));
    expect(orgAppRegisterStatement({ org: ORG, payload: a })).toEqual({ type: "org.app.register@1", org: ORG, payload: a });
  });

  it("puts large values in as digests and keeps regions sorted without duplicates", async () => {
    const declaration = { endUsers: "Staff", uses: [{ capability: "signature", operation: "Approve" }] };
    const d = await orgAppDeclarationStatement({ org: ORG, app: "app-1", declaration });
    expect(d.declaration).toBe(await digestOf({ type: "app.declaration@1", value: declaration }));
    expect(d.declaration).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect((await orgAppDeclarationStatement({ org: ORG, app: "app-1", declaration: null })).declaration).toBeNull();
    expect(orgAppRegionsStatement({ org: ORG, app: "app-1", regions: ["US", "JP", "US"] }).regions).toEqual(["JP", "US"]);
    expect(orgAppRegionsStatement({ org: ORG, app: "app-1", regions: null }).regions).toBeNull();
  });

  it("builds anchor TXT", () => {
    expect(buildAnchorTxtRecord({ hash: "abc", nonce: "n", exp: 9 })).toBe("v=1;kind=anchor;hash=abc;nonce=n;exp=9");
  });
});

describe("receiptFromCeremonyPayload", () => {
  it("keeps the holder receipt as the string Clavis returned, and refuses anything else", () => {
    const text = '{"type":"receipt@1","statement":{"type":"org.policy.bootstrap@1"}}';
    expect(receiptFromCeremonyPayload(text)).toBe(text);
    expect(() => receiptFromCeremonyPayload({ type: "receipt@1", statement: { type: "org.policy.bootstrap@1" } })).toThrow(/receipt/);
    expect(() => receiptFromCeremonyPayload("")).toThrow(/receipt/);
    expect(() => receiptFromCeremonyPayload(null)).toThrow(/receipt/);
  });
});
