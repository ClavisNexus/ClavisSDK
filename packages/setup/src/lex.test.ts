import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify } from "./canonical-json.js";
import { saveSession } from "./session-store.js";
import { createSetupClient } from "./setup-client.js";
import type { SetupOrigins } from "./types.js";

const origins: SetupOrigins = {
  apiOrigin: "https://api.test",
  idOrigin: "https://id.test",
  developersOrigin: "https://developers.test",
};

const ORG = "eu1.550e8400-e29b-41d4-a716-446655440000";
const APP = "app-1";
const JOB = "0".repeat(32);
const RECEIPT = JSON.stringify({ type: "receipt@1", statement: { type: "org.app.lex_profile@1" } });

type Call = { method: string; path: string; body: unknown };
type Reply = { status?: number; body: unknown; raw?: Uint8Array };
type Route = (call: Call) => Reply | undefined;

let calls: Call[] = [];
let dir = "";
let sessionPath = "";

function stubApi(route: Route): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        path: new URL(url).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const res = route(call);
      if (!res) throw new Error(`unexpected ${call.method} ${call.path}`);
      if (res.raw) return new Response(new Uint8Array(res.raw), { status: res.status ?? 200 });
      return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
    }),
  );
}

const ceremony: Route = (c) => {
  if (c.path === "/webauthn/authentication/ceremony/start") return { body: { payload: { ticket: "t1" } } };
  if (c.path === "/webauthn/authentication/ceremony/result") return { body: { payload: { ticket: "t1", receipt: RECEIPT } } };
  return undefined;
};

function client() {
  return createSetupClient({ origins, sessionPath, openBrowser: false });
}

const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
const utf8 = (s: string) => new TextEncoder().encode(s);

beforeEach(async () => {
  calls = [];
  dir = await mkdtemp(join(tmpdir(), "clavis-lex-"));
  sessionPath = join(dir, "session.json");
  await saveSession({ accessToken: "tok", sub: "sub-1" }, origins, sessionPath);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("the agreement profile", () => {
  it("signs the statement Clavis returns for the profile, then sets the same profile with the receipt", async () => {
    const profile = { version: "2026-10-28", service_name: "North", purposes: [], destinations: [], terminal_categories: [] };
    const statement = { type: "org.app.lex_profile@1", org: ORG, app: APP, profile: "sha256:abc" };
    stubApi(
      (c) =>
        ceremony(c) ??
        (c.path === `/orgs/${ORG}/apps/${APP}/lex-profile/statement` ? { body: { statement, profile } } : undefined) ??
        (c.method === "PUT" && c.path === `/orgs/${ORG}/apps/${APP}/lex-profile` ? { body: { app_id: APP, lex_profile: profile } } : undefined),
    );
    const out = await client().appLexProfileSet({ orgId: ORG, appId: APP, profile });
    expect(out).toEqual({ ok: true, data: { app_id: APP, lex_profile: profile } });
    expect(calls.find((c) => c.path === "/webauthn/authentication/ceremony/start")?.body).toMatchObject({ statement });
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ profile, receipt: RECEIPT });
  });

  it("says what to do when a document was not snapshotted first", async () => {
    stubApi((c) =>
      c.path.endsWith("/lex-profile/statement") ? { status: 400, body: { error: "DOCUMENT_NOT_SNAPSHOTTED", message: "x" } } : undefined,
    );
    const out = await client().appLexProfileSet({ orgId: ORG, appId: APP, profile: {} });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("app-lex-document") });
    expect(calls.some((c) => c.path === "/webauthn/authentication/ceremony/start")).toBe(false);
  });
});

describe("exports of agreement records", () => {
  it("starts one person's export without a passkey, and many people's with one over the request", async () => {
    const one = { kind: "subject", query: { subject_ref: "p-1" } };
    const many = { kind: "decisions", query: { from: "2026-01-01T00:00:00.000Z" } };
    stubApi(
      (c) =>
        ceremony(c) ??
        (c.path === `/orgs/${ORG}/lex/exports/statement`
          ? {
              body: {
                statement: (c.body as { request: { kind: string } }).request.kind === "decisions" ? { type: "org.lex.export@1", org: ORG, payload: "sha256:d" } : null,
                request_digest: "sha256:d",
              },
            }
          : undefined) ??
        (c.method === "POST" && c.path === `/orgs/${ORG}/lex/exports` ? { status: 202, body: { job: { job_id: JOB, state: "running" } } } : undefined),
    );
    expect(await client().lexExport({ orgId: ORG, request: one })).toEqual({ ok: true, data: { job: { job_id: JOB, state: "running" } } });
    expect(calls.filter((c) => c.path === "/webauthn/authentication/ceremony/start")).toHaveLength(0);
    expect(calls.find((c) => c.method === "POST" && c.path === `/orgs/${ORG}/lex/exports`)?.body).toEqual({ request: one });
    calls = [];
    await client().lexExport({ orgId: ORG, request: many });
    expect(calls.find((c) => c.path === "/webauthn/authentication/ceremony/start")?.body).toMatchObject({
      statement: { type: "org.lex.export@1", payload: "sha256:d" },
    });
    expect(calls.find((c) => c.method === "POST" && c.path === `/orgs/${ORG}/lex/exports`)?.body).toEqual({ request: many, receipt: RECEIPT });
  });

  it("passes on a running export and a request too large, in words that say what to do", async () => {
    let error = "EXPORT_RUNNING";
    stubApi((c) => (c.path.endsWith("/lex/exports/statement") ? { status: 409, body: { error, message: "x" } } : undefined));
    expect(await client().lexExport({ orgId: ORG, request: {} })).toMatchObject({ ok: false, error: expect.stringContaining("export_running") });
    error = "EXPORT_TOO_LARGE";
    expect(await client().lexExport({ orgId: ORG, request: {} })).toMatchObject({ ok: false, error: expect.stringContaining("query.from") });
  });

  it("downloads a finished export at mode 0600, checking every file and the manifest", async () => {
    const items = utf8('{"decision_id":"d1"}\n');
    const anchor = utf8('{"log_id":"x","index":0}');
    const manifestValue = { kind: "lex.package@1", files: [{ path: "items/00000.jsonl", sha256: sha(items), bytes: items.byteLength }] };
    const manifest = utf8(canonicalStringify(manifestValue));
    let tampered = false;
    stubApi((c) => {
      if (c.path === `/orgs/${ORG}/lex/exports/${JOB}`) return { body: { job: { job_id: JOB, state: "done", manifest_digest: sha(manifest) } } };
      if (c.path.endsWith("/files/manifest.json")) return { body: null, raw: manifest };
      if (c.path.endsWith("/files/items/00000.jsonl")) return { body: null, raw: tampered ? utf8("{}") : items };
      if (c.path.endsWith("/files/anchor.json")) return { body: null, raw: anchor };
      return undefined;
    });
    const out = await client().lexExportDownload({ orgId: ORG, jobId: JOB, dir });
    expect(out).toMatchObject({ ok: true, data: { dir: join(dir, JOB), manifest_digest: sha(manifest) } });
    expect(await readFile(join(dir, JOB, "items/00000.jsonl"), "utf8")).toBe('{"decision_id":"d1"}\n');
    expect((await stat(join(dir, JOB, "items/00000.jsonl"))).mode & 0o777).toBe(0o600);
    tampered = true;
    expect(await client().lexExportDownload({ orgId: ORG, jobId: JOB, dir: join(dir, "again") })).toMatchObject({
      ok: false,
      error: expect.stringContaining("export_file_mismatch"),
    });
  });

  it("does not download an export that is not done", async () => {
    stubApi((c) => (c.path === `/orgs/${ORG}/lex/exports/${JOB}` ? { body: { job: { job_id: JOB, state: "running" } } } : undefined));
    expect(await client().lexExportDownload({ orgId: ORG, jobId: JOB, dir })).toMatchObject({ ok: false, error: expect.stringContaining("export_not_done") });
  });
});
