import { mkdtemp, stat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operatePrivateJwkPath, saveOperatePrivateJwk } from "./operate-key-store.js";

const prev = process.env.CLAVIS_OPERATE_KEYS_DIR;

afterEach(() => {
  if (prev === undefined) delete process.env.CLAVIS_OPERATE_KEYS_DIR;
  else process.env.CLAVIS_OPERATE_KEYS_DIR = prev;
});

describe("operate key paths", () => {
  it("rejects an app id that leaves the key directory", () => {
    process.env.CLAVIS_OPERATE_KEYS_DIR = "/tmp/clavis-keys";
    expect(() => operatePrivateJwkPath("../etc")).toThrow(/invalid_app_id/);
    expect(() => operatePrivateJwkPath("a/../../tmp")).toThrow(/invalid_app_id/);
    expect(() => operatePrivateJwkPath("..\\..\\windows")).toThrow(/invalid_app_id/);
  });

  it("writes the private key as mode 0600 and refuses a symlink", async () => {
    const base = await mkdtemp(join(tmpdir(), "clavis-keys-"));
    process.env.CLAVIS_OPERATE_KEYS_DIR = base;
    const path = await saveOperatePrivateJwk("app-1", '{"kty":"OKP"}');
    expect(path.startsWith(base)).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const linked = "app-2";
    await mkdir(join(base, linked));
    await symlink(path, join(base, linked, "operate-private.jwk.json"));
    await expect(saveOperatePrivateJwk(linked, '{"kty":"OKP"}')).rejects.toThrow(/symlink/);
  });
});
