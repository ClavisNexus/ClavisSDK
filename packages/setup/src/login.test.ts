import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginWithBrowser } from "./login.js";
import { DEFAULT_ORIGINS } from "./types.js";

describe("loginWithBrowser", () => {
  it("rejects an expired pending login before using the pasted token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clavis-login-"));
    await writeFile(
      join(dir, "login-pending.json"),
      JSON.stringify({
        v: 1,
        state: "abc",
        createdAt: Date.now() - 16 * 60 * 1000,
        developersOrigin: DEFAULT_ORIGINS.developersOrigin,
        apiOrigin: DEFAULT_ORIGINS.apiOrigin,
      }),
    );
    await expect(
      loginWithBrowser({
        origins: DEFAULT_ORIGINS,
        open: false,
        bridgeJson: '{"state":"abc","accessToken":"not-a-jwt"}',
        sessionPath: join(dir, "session.json"),
      }),
    ).rejects.toThrow(/pending_login_expired/);
  });
});
