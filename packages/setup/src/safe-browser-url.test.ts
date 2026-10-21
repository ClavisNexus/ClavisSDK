import { describe, expect, it } from "vitest";
import { assertCardCheckoutBrowserUrl, assertOriginBrowserUrl } from "./safe-browser-url.js";

describe("assertCardCheckoutBrowserUrl", () => {
  it("allows the card checkout host and its subdomains", () => {
    expect(assertCardCheckoutBrowserUrl("https://polar.sh/checkout/x")).toContain("polar.sh");
    expect(assertCardCheckoutBrowserUrl("https://buy.polar.sh/x")).toContain("buy.polar.sh");
    expect(assertCardCheckoutBrowserUrl("https://polar.sh/x?a=1&b=2")).toBe("https://polar.sh/x?a=1&b=2");
  });

  it("rejects other hosts", () => {
    expect(() => assertCardCheckoutBrowserUrl("https://evil.example/x")).toThrow(/not allowed/);
    expect(() => assertCardCheckoutBrowserUrl("file:///etc/passwd")).toThrow(/https/);
  });
});

describe("assertOriginBrowserUrl", () => {
  it("requires matching origin", () => {
    const url = assertOriginBrowserUrl("https://id.example/auth/x", "https://id.example");
    expect(url).toBe("https://id.example/auth/x");
    expect(() => assertOriginBrowserUrl("https://other.example/x", "https://id.example")).toThrow(/origin/);
    expect(assertOriginBrowserUrl("http://127.0.0.1:8787/auth/x", "http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787/auth/x",
    );
    expect(() => assertOriginBrowserUrl("http://id.example/auth/x", "http://id.example")).toThrow(/https/);
  });
});
