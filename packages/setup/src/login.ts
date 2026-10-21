import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { openBrowser } from "./browser.js";
import { assertOriginBrowserUrl } from "./safe-browser-url.js";
import { verifyDevelopersAccessToken } from "./access-token-verify.js";
import { defaultSessionPath, saveSession } from "./session-store.js";
import type { DevelopersSession, HumanAction, SetupOrigins } from "./types.js";

const MAX_BRIDGE_JSON_CHARS = 16_384;
const PENDING_LOGIN_TTL_MS = 15 * 60 * 1000;

type PendingLogin = {
  v: 1;
  state: string;
  createdAt: number;
  developersOrigin: string;
  apiOrigin: string;
};

type BridgePayload = {
  state?: string;
  accessToken?: string;
  sub?: string;
  expiresAt?: number;
};

function pendingLoginPath(sessionPath?: string): string {
  const base = sessionPath ? path.dirname(sessionPath) : path.dirname(defaultSessionPath());
  return path.join(base, "login-pending.json");
}

function loginBridgeUrl(developersOrigin: string, state: string): string {
  const bridge = new URL("/developers/setup/login", developersOrigin);
  bridge.searchParams.set("state", state);
  return bridge.toString();
}

async function writePending(pendingPath: string, pending: PendingLogin): Promise<void> {
  await mkdir(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
  await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
}

async function readPending(pendingPath: string): Promise<PendingLogin | null> {
  try {
    const raw = await readFile(pendingPath, "utf8");
    const parsed = JSON.parse(raw) as PendingLogin;
    if (parsed?.v !== 1 || typeof parsed.state !== "string" || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearPending(pendingPath: string): Promise<void> {
  try {
    await unlink(pendingPath);
  } catch {
    /* ignore */
  }
}

function parseBridgePayload(raw: string): BridgePayload {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty_bridge_json");
  if (trimmed.length > MAX_BRIDGE_JSON_CHARS) throw new Error("bridge_json_too_large");
  const body = JSON.parse(trimmed) as BridgePayload;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("bridge_json_not_object");
  }
  return body;
}

async function sessionFromBridge(args: {
  raw: string;
  expectedState: string;
  apiOrigin: string;
}): Promise<DevelopersSession> {
  const body = parseBridgePayload(args.raw);
  if (body.state !== args.expectedState || typeof body.accessToken !== "string" || !body.accessToken) {
    throw new Error("invalid_bridge_json");
  }
  const verified = await verifyDevelopersAccessToken(body.accessToken, args.apiOrigin);
  return {
    accessToken: body.accessToken,
    sub: verified.sub,
    expiresAt: verified.expiresAt,
  };
}

async function readBridgeJsonFromStdin(): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const rl = createInterface({ input, output });
  try {
    output.write(
      "Paste the JSON shown on developers /setup/login, then press Enter.\n(End with a blank line if the paste spans multiple lines.)\n",
    );
    const lines: string[] = [];
    for (;;) {
      const line = await rl.question("");
      if (line.trim() === "" && lines.length > 0) break;
      lines.push(line);
      const joined = lines.join("\n").trim();
      if (joined.startsWith("{") && joined.endsWith("}")) break;
    }
    return lines.join("\n");
  } finally {
    rl.close();
  }
}

/**
 * Save the session from the JSON pasted out of developers `/setup/login`.
 * The browser never POSTs to loopback: that keeps the CSP intact and the token out of reach.
 */
export async function loginWithBrowser(args: {
  origins: SetupOrigins;
  open?: boolean;
  /** The bridge JSON shown on the page. Omitted, the CLI reads it from stdin. */
  bridgeJson?: string;
  /**
   * With no bridgeJson and no stdin, which is MCP's first call, open the browser, keep only the
   * pending state, and return `human`.
   */
  deferPaste?: boolean;
  sessionPath?: string;
}): Promise<{ session?: DevelopersSession; human: HumanAction; pending?: true }> {
  const pendingPath = pendingLoginPath(args.sessionPath);
  const openFlag = args.open !== false;

  if (args.bridgeJson?.trim()) {
    const pending = await readPending(pendingPath);
    if (!pending) {
      throw new Error("no_pending_login — run login again to open the browser first");
    }
    if (pending.apiOrigin !== args.origins.apiOrigin || pending.developersOrigin !== args.origins.developersOrigin) {
      await clearPending(pendingPath);
      throw new Error("pending_login_origin_mismatch — run login again");
    }
    if (!Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > PENDING_LOGIN_TTL_MS) {
      await clearPending(pendingPath);
      throw new Error("pending_login_expired — run login again");
    }
    const openUrl = assertOriginBrowserUrl(
      loginBridgeUrl(args.origins.developersOrigin, pending.state),
      args.origins.developersOrigin,
    );
    const session = await sessionFromBridge({
      raw: args.bridgeJson,
      expectedState: pending.state,
      apiOrigin: args.origins.apiOrigin,
    });
    await saveSession(session, args.origins, args.sessionPath);
    await clearPending(pendingPath);
    return {
      session,
      human: {
        needs_human: "login",
        message: "Session stored.",
        open_url: openUrl,
      },
    };
  }

  const state = randomBytes(16).toString("hex");
  const openUrl = assertOriginBrowserUrl(
    loginBridgeUrl(args.origins.developersOrigin, state),
    args.origins.developersOrigin,
  );
  await writePending(pendingPath, {
    v: 1,
    state,
    createdAt: Date.now(),
    developersOrigin: args.origins.developersOrigin,
    apiOrigin: args.origins.apiOrigin,
  });

  if (openFlag) {
    try {
      await openBrowser(openUrl);
    } catch {
      // Caller still gets open_url via human action.
    }
  }

  if (args.deferPaste) {
    return {
      pending: true,
      human: {
        needs_human: "login",
        message:
          "Complete Passkey in the browser, copy the JSON on the page, then call login again with bridge_json.",
        open_url: openUrl,
      },
    };
  }

  const raw = await readBridgeJsonFromStdin();
  const session = await sessionFromBridge({
    raw,
    expectedState: state,
    apiOrigin: args.origins.apiOrigin,
  });
  await saveSession(session, args.origins, args.sessionPath);
  await clearPending(pendingPath);
  return {
    session,
    human: {
      needs_human: "login",
      message: "Session stored. You can close the browser tab.",
      open_url: openUrl,
    },
  };
}
