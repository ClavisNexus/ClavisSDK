/**
 * 試験の材料。照合器のリポジトリの見本（`vectors/collatio-ops-1.json`。照合器から独立した発行者が書いた受領・委任の記録・
 * 証拠束と信頼の文書）を、同梱の照合器で本当に照合する。見本の目録と次元の定義は試験用のダイジェストで照合器を名指すので、
 * 同梱の照合器をそのダイジェストでも読み込ませる（`verifiers`）。
 */
import { contentDigest } from "./trust.js";
import { bundledVerifierBytes, type VerifierModule } from "./verifier.js";
import ops from "./vectors/collatio-ops-1.json";

type Case = { name: string; input: Record<string, unknown>; answer: Record<string, unknown> };
const vectors = ops as unknown as { cases: Case[] };
const utf8 = (s: string) => new TextEncoder().encode(s);

export function vector(name: string): Case {
  const c = vectors.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no vector ${name}`);
  return c;
}

/** 見本の目録と次元の定義が名指す、試験用の照合器のダイジェスト */
export const VECTOR_VERIFIER = await contentDigest(utf8("collatio test module"));

/** 同梱の照合器を、見本が名指すダイジェストで読み込ませる */
export async function vectorVerifiers(): Promise<VerifierModule[]> {
  const bytes = await bundledVerifierBytes();
  if (!bytes) throw new Error("the bundled collatio.wasm did not load");
  return [{ digest: VECTOR_VERIFIER, module: await WebAssembly.compile(new Uint8Array(bytes)) }];
}

export type Trust = { master: JsonWebKey; jwks: string; catalog: string; registries: string[] };
export const TRUST = vector("app_receipt").input.trust as Trust;
export const MASTER = TRUST.master;

const appReceipt = vector("app_receipt");
/** 見本の App 向けの受領（文字列）と、その文型 */
export const APP_RECEIPT = appReceipt.input.evidence as string;
export const APP_STATEMENT = JSON.parse(APP_RECEIPT).statement as { type: string; request: string; app: string; digest: string };
export const PAIRWISE = (appReceipt.input.expect as { signer: string }).signer;
/** 受領の印を含む第一者のシャードのチェックポイント（大きさ 43）と、その包含証明 */
export const ANCHOR_CHECKPOINT = vector("ledger_note: a first-party checkpoint covering the app receipt's anchor").input.note as string;
export const ANCHOR_INCLUSION = vector("inclusion: the app receipt's anchor in that checkpoint").input.proof as string[];

export const TRUST_ORIGIN = "https://trust.clavis.test";
export const API_ORIGIN = "https://api.clavis.test";

/** 目録が名指す登録表（照合面は、文書の正準形のダイジェストを名前にして置く） */
const REGISTRY_PATH = `/v1/registries/${(JSON.parse(TRUST.catalog) as { registries: string[] }).registries[0]}.json`;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | null;

/**
 * 照合面と API の作り物。照合面は見本の信頼の文書・登録表と、受領の印を含むチェックポイントを置き、API は第一者のシャードの
 * 包含証明を出す。`api` に App 向けの API の応答を書く。呼ばれた URL を `calls` に残す。
 */
export function fakeNet(api: Handler = () => null, over: { checkpoint?: string | null; inclusion?: string[] | null } = {}) {
  const calls: string[] = [];
  const registry = TRUST.registries[0]!;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}${url.search}`);
    if (url.origin === TRUST_ORIGIN) {
      if (url.pathname === "/v1/jwks.json") return new Response(TRUST.jwks);
      if (url.pathname === "/v1/catalog.json") return new Response(TRUST.catalog);
      if (url.pathname === REGISTRY_PATH) return new Response(registry);
      if (url.pathname === "/v1/logs/first-party.0/checkpoint") {
        const cp = over.checkpoint === undefined ? ANCHOR_CHECKPOINT : over.checkpoint;
        return cp === null ? new Response("not found", { status: 404 }) : new Response(cp);
      }
      return new Response("not found", { status: 404 });
    }
    if (url.origin === API_ORIGIN && url.pathname === "/archive/ledger/first-party.0/proof") {
      const inclusion = over.inclusion === undefined ? ANCHOR_INCLUSION : over.inclusion;
      // 見本の包含証明は、App 向けの受領の印（インデックス 42）のものだけ
      if (inclusion === null || url.searchParams.get("index") !== "42") return jsonResponse({ error: "NO_PROOF" }, 404);
      return jsonResponse({ log: "first-party.0", index: Number(url.searchParams.get("index")), size: Number(url.searchParams.get("size")), inclusion });
    }
    const answered = await api(url, init);
    if (answered) return answered;
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

/**
 * 見本の第一者のシャード `first-party.0` の台帳の鍵（Ed25519）。見本の発行者（Collatio の `tools/genesis-vectors.mjs`）と
 * 同じ決まりで種から作る。集約 JWKS の `ledger-log` の鍵なので、Org のログの受領証とチェックポイントにも署名できる。
 */
export async function vectorLedgerSigner() {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("collatio.vectors/ed25519/ledger-first-party-0")));
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const key = await crypto.subtle.importKey("pkcs8", new Uint8Array([...prefix, ...seed]), { name: "Ed25519" }, true, ["sign"]);
  const x = (await crypto.subtle.exportKey("jwk", key)).x!;
  const raw = Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const kid = (JSON.parse(TRUST.catalog) as { logs: { id: string; kid: string }[] }).logs.find((l) => l.id === "first-party.0")!.kid;
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return {
    kid,
    async sign(body: string): Promise<string> {
      const keyHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...utf8(`${kid}\n`), 0x01, ...raw]))).subarray(0, 4);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(body)));
      return `${body}\n— ${kid} ${b64(new Uint8Array([...keyHash, ...sig]))}\n`;
    },
  };
}
