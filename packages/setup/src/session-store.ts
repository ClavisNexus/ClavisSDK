import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeMode600 } from "./private-file.js";
import type { DevelopersSession, SetupOrigins } from "./types.js";
import { DEFAULT_ORIGINS } from "./types.js";

export type StoredSetupSession = {
  v: 1;
  origins: SetupOrigins;
  session: DevelopersSession;
  savedAt: number;
};

export function defaultSessionPath(): string {
  const override = process.env.CLAVIS_SESSION_PATH?.trim();
  if (override) return override;
  return join(homedir(), ".config", "clavis", "session.json");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** https, or http on a loopback host. What comes back is the origin. */
export function assertSetupOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) throw new Error(`${name} must be https`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} must be an origin`);
  return url.origin;
}

export function originsFromEnv(overrides?: Partial<SetupOrigins>): SetupOrigins {
  return {
    apiOrigin: assertSetupOrigin(
      overrides?.apiOrigin ?? process.env.CLAVIS_API_ORIGIN?.trim() ?? DEFAULT_ORIGINS.apiOrigin,
      "apiOrigin",
    ),
    idOrigin: assertSetupOrigin(
      overrides?.idOrigin ?? process.env.CLAVIS_ID_ORIGIN?.trim() ?? DEFAULT_ORIGINS.idOrigin,
      "idOrigin",
    ),
    developersOrigin: assertSetupOrigin(
      overrides?.developersOrigin ?? process.env.CLAVIS_DEVELOPERS_ORIGIN?.trim() ?? DEFAULT_ORIGINS.developersOrigin,
      "developersOrigin",
    ),
  };
}

export async function loadSession(path = defaultSessionPath()): Promise<StoredSetupSession | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as StoredSetupSession;
    if (parsed?.v !== 1 || typeof parsed.session?.accessToken !== "string") return null;
    if (parsed.session.expiresAt && parsed.session.expiresAt * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(
  session: DevelopersSession,
  origins: SetupOrigins,
  path = defaultSessionPath(),
): Promise<void> {
  const body: StoredSetupSession = { v: 1, origins, session, savedAt: Date.now() };
  await writeMode600(path, JSON.stringify(body, null, 2));
}

export async function clearSession(path = defaultSessionPath()): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
