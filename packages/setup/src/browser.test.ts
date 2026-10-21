import { describe, expect, it } from "vitest";
import { windowsBrowserArgs } from "./browser.js";

describe("windowsBrowserArgs", () => {
  it("keeps query separators inside one PowerShell command", () => {
    const args = windowsBrowserArgs("https://polar.sh/x?a=1&b=2|calc");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
    expect(script).toBe("Start-Process -FilePath 'https://polar.sh/x?a=1&b=2|calc'");
  });

  it("rejects a cleartext URL that is not loopback", () => {
    expect(() => windowsBrowserArgs("http://evil.example/x")).toThrow(/https/);
  });
});
