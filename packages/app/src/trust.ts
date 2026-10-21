/**
 * Reads the trust documents from the trust surface (`https://trust.<apex>`). Where they are served is
 * not trusted: the verifier checks the keys that signed the aggregate JWKS and the catalog against
 * Clavis's Master public key (`trustRoot`). Verifiers, registries and dimension definitions are
 * content-addressed, and their hashes are checked.
 *
 * - The catalog and the aggregate JWKS are fetched again once a day. When a fetch fails, the copy in
 *   hand carries on. Seven days after the last successful fetch, `catalogStale` on the result of a
 *   check turns true. It counts the days since a fetch last succeeded, not the time the catalog was
 *   signed.
 * - Given more than one trust surface origin, they are tried in order. A copy is not trusted, so it
 *   makes no difference which one serves it.
 */
import { AppClientError } from "./errors.js";
import { REGISTRY_DIGEST, REGISTRY_DOCUMENT } from "./registry.generated.js";

/** The trust documents passed to the verifier as `trust`, each as the string that arrived */
export type CollatioTrust = { master: JsonWebKey; jwks: string; catalog: string; registries: string[] };

const REFRESH_MS = 86_400_000;
/** Past this long since the last successful fetch from the trust surface, the catalog in hand is stale: a revocation may not have reached it */
export const CATALOG_STALE_MS = 7 * 86_400_000;

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function contentDigest(bytes: Uint8Array): Promise<string> {
  return `sha256:${b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)))}`;
}

/** Build `https://trust.<apex>` from `https://api.<apex>`; any other shape is null */
export function trustOriginFor(apiOrigin: string): string | null {
  const u = new URL(apiOrigin);
  return u.hostname.startsWith("api.") ? `${u.protocol}//trust.${u.hostname.slice(4)}${u.port ? `:${u.port}` : ""}` : null;
}

/** Read Clavis's Master public JWK (EC P-256). It is a different key from the 2.x `masterPublicJwkJson` */
export function parseTrustRoot(raw: JsonWebKey | string): JsonWebKey {
  let jwk: unknown = raw;
  if (typeof raw === "string") {
    try {
      jwk = JSON.parse(raw);
    } catch {
      throw new AppClientError("invalid_trust_root", "trustRoot must be the Master public JWK (JSON)");
    }
  }
  const r = jwk as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || r.kty !== "EC" || r.crv !== "P-256" || typeof r.x !== "string" || typeof r.y !== "string") {
    throw new AppClientError("invalid_trust_root", "trustRoot must be the Master public JWK (EC P-256)");
  }
  if ("d" in r) throw new AppClientError("invalid_trust_root", "trustRoot must be a public key");
  return { kty: "EC", crv: "P-256", x: r.x, y: r.y };
}

export class TrustSurface {
  readonly origins: readonly string[];
  #master: JsonWebKey;
  #fetch: typeof fetch;
  /** `at` is when to fetch again, which `invalidate` sets to 0; `fetchedAt` is when a fetch last succeeded */
  #docs: { jwks: string; catalog: string; at: number; fetchedAt: number } | null = null;
  #inflight: Promise<{ jwks: string; catalog: string }> | null = null;
  #registries = new Map<string, string>([[REGISTRY_DIGEST, REGISTRY_DOCUMENT]]);

  constructor(args: { origins: readonly string[]; master: JsonWebKey; fetchImpl: typeof fetch }) {
    if (args.origins.length === 0) throw new AppClientError("invalid_trust_origin", "at least one trust origin is required");
    this.origins = args.origins;
    this.#master = args.master;
    this.#fetch = args.fetchImpl;
  }

  /** Read from the trust surface. The origins are tried in order, and the first that answers is returned */
  async #get(path: string, accept: string): Promise<Response> {
    let last: unknown = null;
    for (const origin of this.origins) {
      try {
        const res = await this.#fetch(`${origin}${path}`, { headers: { accept }, redirect: "error" });
        if (res.ok) return res;
        last = new Error(`HTTP ${res.status}`);
      } catch (e) {
        last = e;
      }
    }
    throw new AppClientError("trust_unavailable", `the trust surface did not answer ${path}`, undefined, { cause: last });
  }

  async text(path: string): Promise<string> {
    return (await this.#get(path, "application/json, text/plain")).text();
  }

  /** Fetch a content-addressed item, and check that its hash is the name it was fetched by */
  async addressed(path: string, digest: string): Promise<Uint8Array> {
    const bytes = new Uint8Array(await (await this.#get(path, "*/*")).arrayBuffer());
    if ((await contentDigest(bytes)) !== digest) {
      throw new AppClientError("trust_unavailable", `${path} does not hash to its name`);
    }
    return bytes;
  }

  /** The aggregate JWKS and the catalog, fetched again once a day, falling back to the copy in hand */
  async documents(): Promise<{ jwks: string; catalog: string }> {
    const now = Date.now();
    if (this.#docs && now - this.#docs.at < REFRESH_MS) return this.#docs;
    this.#inflight ??= (async () => {
      try {
        const [jwks, catalog] = await Promise.all([this.text("/v1/jwks.json"), this.text("/v1/catalog.json")]);
        const at = Date.now();
        this.#docs = { jwks, catalog, at, fetchedAt: at };
        return this.#docs;
      } catch (e) {
        if (this.#docs) return this.#docs;
        throw e;
      }
    })().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /** Whether the catalog in hand is stale: 7 days since the last successful fetch from the trust surface. False when nothing has been fetched yet */
  stale(nowMs: number = Date.now()): boolean {
    return this.#docs !== null && nowMs - this.#docs.fetchedAt > CATALOG_STALE_MS;
  }

  /** Force a fetch on the next read, for instance when a receipt arrives under a key this process does not know */
  invalidate(): void {
    if (this.#docs) this.#docs = { ...this.#docs, at: 0 };
  }

  /**
   * A registry document, bundled or from `/v1/registries/<digest>.json` on the trust surface. The
   * digest is of the document's canonical form, and the verifier checks it against the one named
   * before reading it; it is not checked here.
   */
  async registry(digest: string): Promise<string> {
    const held = this.#registries.get(digest);
    if (held !== undefined) return held;
    const text = await this.text(`/v1/registries/${digest}.json`);
    this.#registries.set(digest, text);
    return text;
  }

  /** The trust documents passed to the verifier. The registries are those in hand among the ones the catalog lists; `withRegistries` adds what is missing */
  async trust(): Promise<CollatioTrust> {
    const { jwks, catalog } = await this.documents();
    return { master: this.#master, jwks, catalog, registries: [...this.#registries.values()] };
  }

  /** Fetch the registries the catalog lists that are not in hand, then return the trust documents */
  async withRegistries(digests: readonly string[]): Promise<CollatioTrust> {
    for (const d of digests) {
      try {
        await this.registry(d);
      } catch {
        // A registry that cannot be fetched is not passed: the verifier refuses a receipt naming it with `registry_missing`
      }
    }
    return this.trust();
  }

  /** A verifier's bytes, from `/v1/verifiers/<digest>.wasm`, with the hash checked */
  verifierBytes(digest: string): Promise<Uint8Array> {
    return this.addressed(`/v1/verifiers/${digest}.wasm`, digest);
  }

  /** That log's latest checkpoint, as a signed note. Only the first-party shards and the anchor are served */
  checkpoint(log: string): Promise<string> {
    return this.text(`/v1/logs/${encodeURIComponent(log)}/checkpoint`);
  }
}
