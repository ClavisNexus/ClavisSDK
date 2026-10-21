import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originsFromEnv, saveSession } from "./session-store.js";
import { DEFAULT_ORIGINS } from "./types.js";

const origins = {
  apiOrigin: "https://api.example",
  idOrigin: "https://id.example",
  developersOrigin: "https://developers.example",
};

describe("setup origins", () => {
  it("rejects a cleartext remote origin and keeps loopback http", () => {
    expect(() => originsFromEnv({ ...origins, apiOrigin: "http://evil.example" })).toThrow(/https/);
    expect(originsFromEnv({ ...origins, apiOrigin: "http://127.0.0.1:8787" }).apiOrigin).toBe("http://127.0.0.1:8787");
  });
});

describe("saveSession", () => {
  it("stores the bearer as mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clavis-session-"));
    const path = join(dir, "session.json");
    await saveSession({ accessToken: "token", sub: "user" }, DEFAULT_ORIGINS, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
