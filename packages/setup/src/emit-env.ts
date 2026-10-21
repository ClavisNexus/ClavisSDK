import * as api from "./org-api.js";
import { saveOperatePrivateJwk, writeAppEnvFile } from "./operate-key-store.js";
import type { SetupOrigins } from "./types.js";

export type EmitAppEnvResult = {
  /** A file at mode 0600, for `source`. It never goes to stdout or to MCP. */
  env_file: string;
  operate_private_jwk_path: string;
  /** The entries that hold no secret. */
  public_env: {
    CLAVIS_API_ORIGIN: string;
    CLAVIS_APP_ID: string;
  };
  shell: string;
};

export async function emitAppEnv(args: {
  origins: SetupOrigins;
  appId: string;
  operatePrivateJwkJson: string;
  /**
   * Clavis's Master public JWK as JSON, which is `trustRoot` for `@clavis.nexus/app`. Take the value
   * docs.clavis.nexus publishes and check it by another route before passing it. Left out,
   * `CLAVIS_TRUST_ROOT` is read instead. It is written only after the trust surface's documents are
   * checked to chain to this key.
   */
  trustRoot?: string;
}): Promise<EmitAppEnvResult> {
  const pin = args.trustRoot?.trim() || process.env.CLAVIS_TRUST_ROOT?.trim() || "";
  if (!pin) {
    throw new Error("CLAVIS_TRUST_ROOT is required. Set it to the Clavis Master public JWK (docs.clavis.nexus).");
  }
  const trustRoot = await api.checkTrustRoot(args.origins.apiOrigin, pin);
  const operatePath = await saveOperatePrivateJwk(args.appId, args.operatePrivateJwkJson);
  const envRecord: Record<string, string> = {
    CLAVIS_API_ORIGIN: args.origins.apiOrigin,
    CLAVIS_APP_ID: args.appId,
    OPERATE_PRIVATE_JWK: args.operatePrivateJwkJson,
    CLAVIS_TRUST_ROOT: trustRoot,
  };
  const envFile = await writeAppEnvFile(args.appId, formatEnvExport(envRecord));
  return {
    env_file: envFile,
    operate_private_jwk_path: operatePath,
    public_env: {
      CLAVIS_API_ORIGIN: args.origins.apiOrigin,
      CLAVIS_APP_ID: args.appId,
    },
    shell: `set -a && . ${shellQuote(envFile)} && set +a`,
  };
}

export function formatEnvExport(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n");
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
