/**
 * Holds the Collatio verifier (WASM) and calls it. Receipts, delegation records and proof bundles go
 * in as the strings that arrived, and what they hold is read from the verifier's answer: the SDK
 * never reads the evidence itself.
 *
 * - On Node it reads the bundled verifier, `collatio.wasm` from `@clavis.nexus/collatio`.
 * - `verifiers` adds verifiers, as bytes or as a compiled `WebAssembly.Module` with its digest. On a
 *   runtime that cannot compile WASM at runtime (Cloudflare Workers and similar), only what is passed
 *   there is used.
 * - When the receipt names a verifier this process lacks (`verifier_unavailable`), Node fetches the
 *   ones it lacks from the trust surface among those the catalog lists, checks their hashes, adds
 *   them and calls again.
 */
import { Collatio, moduleDigest, type Answer } from "@clavis.nexus/collatio";
import { AppClientError } from "./errors.js";

/** A verifier to add: bytes, whose digest is checked when you give one, or a compiled module with its digest */
export type VerifierModule = Uint8Array | { bytes: Uint8Array; digest?: string } | { digest: string; module: WebAssembly.Module };

type Compiled = { digest: string; module: WebAssembly.Module };

/** Read the bundled verifier's bytes, on Node only; null on any other runtime */
export async function bundledVerifierBytes(): Promise<Uint8Array | null> {
  try {
    // Keep the specifier in a variable so a bundler cannot resolve this import; off Node it throws and gives null
    const moduleSpec = "node:module";
    const fsSpec = "node:fs/promises";
    const { createRequire } = (await import(moduleSpec)) as { createRequire(url: string): { resolve(spec: string): string } };
    const { readFile } = (await import(fsSpec)) as { readFile(path: string): Promise<Uint8Array> };
    const require = createRequire(import.meta.url);
    return new Uint8Array(await readFile(require.resolve("@clavis.nexus/collatio/collatio.wasm")));
  } catch {
    return null;
  }
}

async function compile(entry: VerifierModule): Promise<Compiled> {
  if ("module" in entry) return { digest: entry.digest, module: entry.module };
  const bytes = entry instanceof Uint8Array ? entry : entry.bytes;
  const digest = await moduleDigest(new Uint8Array(bytes));
  if (!(entry instanceof Uint8Array) && entry.digest !== undefined && entry.digest !== digest) {
    throw new AppClientError("invalid_verifier", `verifier bytes hash to ${digest}, not ${entry.digest}`);
  }
  return { digest, module: await WebAssembly.compile(new Uint8Array(bytes)) };
}

export type FetchVerifier = (digest: string) => Promise<Uint8Array>;

export class VerifierHost {
  #extra: readonly VerifierModule[];
  #fetchVerifier: FetchVerifier;
  #loaded: Promise<{ collatio: Collatio; canCompile: boolean; modules: Compiled[] }> | null = null;

  constructor(extra: readonly VerifierModule[] = [], fetchVerifier: FetchVerifier) {
    this.#extra = extra;
    this.#fetchVerifier = fetchVerifier;
  }

  #load() {
    this.#loaded ??= (async () => {
      const modules: Compiled[] = [];
      const bundled = await bundledVerifierBytes();
      if (bundled) modules.push(await compile(bundled));
      for (const entry of this.#extra) {
        const m = await compile(entry);
        if (!modules.some((x) => x.digest === m.digest)) modules.push(m);
      }
      if (modules.length === 0) {
        throw new AppClientError("verifier_unavailable", "no verifier: pass `verifiers` where the bundled collatio.wasm cannot be read");
      }
      return { collatio: await Collatio.load(modules), canCompile: bundled !== null, modules };
    })().catch((e) => {
      this.#loaded = null;
      throw e;
    });
    return this.#loaded;
  }

  /** The digests of the verifiers loaded, the default one first */
  async digests(): Promise<readonly string[]> {
    return (await this.#load()).collatio.digests;
  }

  /** Call once. When the receipt names a verifier this process lacks, Node adds it from the trust surface and calls again */
  async call(input: Record<string, unknown>): Promise<Answer> {
    const loaded = await this.#load();
    const answer = await loaded.collatio.call(input);
    if (answer.ok || answer.reason !== "verifier_unavailable" || !loaded.canCompile || input.trust === undefined) return answer;
    // Add the verifiers this process lacks among those the catalog lists and has not revoked; the catalog is read from the verifier's answer
    const trust = await loaded.collatio.call({ op: "trust", trust: input.trust });
    if (!trust.ok) return answer;
    const listed = (trust.verifiers as { digest: string }[]).map((v) => v.digest);
    const revoked = new Set((trust.revoked as { verifier: string }[]).map((r) => r.verifier));
    const held = new Set(loaded.modules.map((m) => m.digest));
    const missing = listed.filter((d) => !revoked.has(d) && !held.has(d));
    if (missing.length === 0) return answer;
    const added: Compiled[] = [];
    for (const digest of missing) {
      try {
        added.push(await compile({ bytes: await this.#fetchVerifier(digest), digest }));
      } catch {
        // Skip a verifier that cannot be fetched: another one may be enough to get an answer
      }
    }
    if (added.length === 0) return answer;
    const modules = [...loaded.modules, ...added];
    const next = { collatio: await Collatio.load(modules), canCompile: true, modules };
    this.#loaded = Promise.resolve(next);
    return next.collatio.call(input);
  }
}
