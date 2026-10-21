#!/usr/bin/env node
// Copies the Collatio JavaScript host and collatio.wasm into packages/collatio until
// @clavis.nexus/collatio is published (ClavisNexus genesis.md §18.1, the same copy as Nexus's
// scripts/sync-collatio.mjs). Records the source commit, its release tag (vX.Y.Z) when it has one,
// and the module digest in packages/collatio/source.json, and copies the genesis vectors for the
// app's tests.
//
//   node scripts/sync-collatio.mjs [path/to/Collatio]
//
// The default is the Collatio checkout next to this repository's main worktree. Build the module
// there first (./build.sh); this script refuses a working tree with uncommitted changes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const mainCheckout = dirname(resolve(repo, git(repo, "rev-parse", "--git-common-dir")));
const source = resolve(process.argv[2] ?? join(mainCheckout, "..", "Collatio"));

if (git(source, "status", "--porcelain")) throw new Error(`${source} has uncommitted changes`);
const commit = git(source, "rev-parse", "HEAD");
// The release tag, not the Go module's own go/vX.Y.Z tag on the same commit
const tag =
  git(source, "tag", "--points-at", "HEAD")
    .split("\n")
    .find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? null;
const out = join(repo, "packages", "collatio");
for (const file of ["collatio.mjs", "collatio.d.ts", "THIRD-PARTY-NOTICES.md"]) copyFileSync(join(source, "js", file), join(out, file));
const wasm = readFileSync(join(source, "out", "collatio.wasm"));
writeFileSync(join(out, "collatio.wasm"), wasm);
const digest = `sha256:${createHash("sha256").update(wasm).digest("base64url")}`;
writeFileSync(
  join(out, "source.json"),
  `${JSON.stringify({ repository: "https://github.com/clavisnexus/collatio", commit, ...(tag ? { tag } : {}), digest }, null, 2)}\n`,
);
// The module's genesis vectors: the SDK's tests run the receipts, records and bundles in them
copyFileSync(join(source, "vectors", "genesis", "ops-1.json"), join(repo, "packages", "app", "src", "vectors", "collatio-ops-1.json"));
console.log(`[sync-collatio] ${commit.slice(0, 12)}${tag ? ` ${tag}` : " (untagged)"} ${digest}`);
