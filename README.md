# Clavis SDK

npm packages for Clavis Apps: Sign in and Link, signature registration, agreements, the browser handoff shell, and the developers setup CLI / MCP. Guides live on [docs.clavis.nexus](https://docs.clavis.nexus).

Clavis App 向けの公開 npm パッケージです。サインインと連携、署名依頼、同意、ブラウザの受け渡し殻、developers のセットアップ CLI／MCP。手順の正本は [docs.clavis.nexus](https://docs.clavis.nexus) です。

| Package | |
|---|---|
| [`@clavis.nexus/app`](packages/app) | Server SDK. Sign in and Link, register a signature request, status, webhook ping, ledger notes and evidence, agreements. Receipts, delegation records and evidence bundles are checked with the Collatio verifier ([github.com/clavisnexus/collatio](https://github.com/clavisnexus/collatio)). |
| [`@clavis.nexus/app-shell`](packages/app-shell) | Browser pieces: the handoff overlay until Connect takes over, and the Sign in with Clavis button. |
| [`@clavis.nexus/setup`](packages/setup) | Developers setup CLI and MCP. Passkey and consent stay with a person. |

`message_digest` is out of scope here. Pass a digest string the caller prepared when registering.

## Development

```bash
pnpm install
pnpm --filter @clavis.nexus/app build
pnpm --filter @clavis.nexus/app-shell build
pnpm --filter @clavis.nexus/setup build
pnpm typecheck
pnpm test
```

Node.js 24 or later.

## Release

`.github/workflows/publish.yml` publishes through npm trusted publishing; no npm token is used. Raise `version` in `packages/<dir>/package.json` through a pull request to `main` (`X.Y.Z` only, above npm latest), then, once its checks on `main` have passed, tag the merged commit:

```bash
git tag app-v3.0.1 && git push origin app-v3.0.1
```

The workflow inspects, builds, tests, packs and stages on npm. Before approving with 2FA under Staged Packages on npmjs.com, check that the commit in the run's summary is on `main` and that the integrity of the `stage` job matches the one npmjs.com shows. The trusted publisher on npm allows staging only (`npm publish` and `npm dist-tag` are not allowed). Set the package's Publishing access to require two-factor authentication and disallow tokens.

`setup` depends on `@clavis.nexus/app`. Approve the new `app` release before tagging `setup`. `scripts/release-check.mjs` stops when a packed `package.json` depends on a workspace package version that is not on npm.

`app` pins `@clavis.nexus/collatio`. When that version changes, check out Collatio at the matching tag (`vX.Y.Z`) and refresh the test fixtures with `node scripts/sync-collatio.mjs` (`packages/app/src/vectors/collatio-ops-1.json`).

## Dependency audit

`ci` runs `pnpm run audit:security` (`scripts/audit-security.mjs`) before install and fails on any high or critical advisory `pnpm audit` reports. The daily schedule runs it too.

An advisory with no fixed release cannot be fixed here, and it stops every pull request at the same step. It passes only through an exception in `scripts/audit-exceptions.json`, and only when all of these hold:

- It is not in the published package's dependencies. `pnpm audit --prod` takes no exception and always fails on high or critical
- No attacker-controlled input reaches it (for example, a build or test tool that only receives values written in this repository)
- Updating dependencies or `overrides` cannot remove it

An exception names the advisory ID, the package, the exact versions found, the reason, the day it was decided (`decided`) and its last day (`until`, at most 30 days after `decided`). A pull request that adds or extends one weakens a required check, so its description states the reason, the impact and when it comes off, and a maintainer confirms it before merge.

The script fails without applying the exception when:

- `until` has passed. Read the advisory again, then drop or extend the exception
- A version or package the exception does not name is found
- A fixed release is published and is older than `minimumReleaseAge` (7 days). Until then it still passes, since the fix cannot be installed yet, and prints the day it can be. After that, update the lockfile and drop the exception
- No advisory matches the exception any more. Drop it
- The audit or registry response cannot be read

Test the script with `pnpm run test:scripts` (no install needed).

## Security

Report a vulnerability to security@clavis.nexus. The policy is at [legal.clavis.nexus/en/security](https://legal.clavis.nexus/en/security).

## License

MIT
