import { chmod, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { writeMode600 } from "./private-file.js";

/** The same grammar as the Org's `app_id`: no path separator and no `..`. */
const APP_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,126})$/;

export function assertOperateAppId(appId: string): string {
  const app = appId.trim().toLowerCase();
  if (!APP_ID_RE.test(app)) throw new Error("invalid_app_id");
  return app;
}

function keysBase(): string {
  const override = process.env.CLAVIS_OPERATE_KEYS_DIR?.trim();
  return resolve(override || join(homedir(), ".config", "clavis", "apps"));
}

function pathInsideKeys(appId: string, file: string): string {
  const app = assertOperateAppId(appId);
  const base = keysBase();
  const path = resolve(base, app, file);
  const rel = relative(base, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid_app_id");
  return path;
}

export function operatePrivateJwkPath(appId: string): string {
  return pathInsideKeys(appId, "operate-private.jwk.json");
}

export function appEnvFilePath(appId: string): string {
  return pathInsideKeys(appId, "app.env");
}

/** Save the operate private key locally at mode 0600, and return its path. */
export async function saveOperatePrivateJwk(appId: string, jwkJson: string): Promise<string> {
  const path = operatePrivateJwkPath(appId);
  await writeMode600(path, `${jwkJson.trim()}\n`);
  await chmod(dirname(path), 0o700).catch(() => undefined);
  return path;
}

export async function readOperatePrivateJwk(appId: string): Promise<string | null> {
  try {
    const raw = await readFile(operatePrivateJwkPath(appId), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/** Write the env that holds secrets to a file, saved at mode 0600. */
export async function writeAppEnvFile(appId: string, contents: string): Promise<string> {
  const path = appEnvFilePath(appId);
  await writeMode600(path, contents.endsWith("\n") ? contents : `${contents}\n`);
  return path;
}
