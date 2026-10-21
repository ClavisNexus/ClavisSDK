import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function refuseSymlink(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${path}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

/** Write a secret file at mode 0600. When the permissions cannot be settled, nothing is left behind. */
export async function writeMode600(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await refuseSymlink(dir);
  await refuseSymlink(path);
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch (e) {
    await unlink(path).catch(() => undefined);
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`could not set mode 0600 on ${path}: ${message}`);
  }
}
