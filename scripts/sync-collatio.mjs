#!/usr/bin/env node
// Copies the Collatio genesis vectors that the app's tests run (receipts, records and bundles) from
// a Collatio checkout at the release tag of the @clavis.nexus/collatio version the app depends on.
// The verifier itself comes from npm.
//
//   node scripts/sync-collatio.mjs [path/to/Collatio]
//
// The default is the Collatio checkout next to this repository's main worktree. This script refuses a
// working tree with uncommitted changes or a HEAD without the matching vX.Y.Z tag.

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const mainCheckout = dirname(resolve(repo, git(repo, "rev-parse", "--git-common-dir")));
const source = resolve(process.argv[2] ?? join(mainCheckout, "..", "Collatio"));

const version = JSON.parse(readFileSync(join(repo, "packages", "app", "package.json"), "utf8")).dependencies["@clavis.nexus/collatio"];
const tag = `v${version}`;
if (git(source, "status", "--porcelain")) throw new Error(`${source} has uncommitted changes`);
if (!git(source, "tag", "--points-at", "HEAD").split("\n").includes(tag)) {
  throw new Error(`${source} HEAD is not ${tag} (@clavis.nexus/collatio ${version}); check out ${tag} first`);
}
copyFileSync(join(source, "vectors", "genesis", "ops-1.json"), join(repo, "packages", "app", "src", "vectors", "collatio-ops-1.json"));
console.log(`[sync-collatio] ${tag} ${git(source, "rev-parse", "--short=12", "HEAD")}`);
