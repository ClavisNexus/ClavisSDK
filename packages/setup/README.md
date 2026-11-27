# `@clavis.nexus/setup`

CLI and MCP for starting an Org and an App on developers.

A person handles the passkey, the card checkout and publishing DNS, in a browser or on their infrastructure. An agent handles order, drafts and reading status. The steps follow the Quickstart (CLI and agents) on [docs.clavis.nexus](https://docs.clavis.nexus).

## Install

```bash
npm install -g @clavis.nexus/setup
clavis status
```

To run it once without installing, use `npx -y @clavis.nexus/setup status`.

Example MCP configuration (Cursor and similar):

```json
{
  "mcpServers": {
    "clavis-setup": {
      "command": "npx",
      "args": ["-y", "@clavis.nexus/setup", "mcp"],
      "env": {
        "CLAVIS_API_ORIGIN": "https://api.clavis.nexus",
        "CLAVIS_ID_ORIGIN": "https://id.clavis.nexus",
        "CLAVIS_DEVELOPERS_ORIGIN": "https://developers.clavis.nexus"
      }
    }
  }
}
```

`clavis mcp` starts the same process.

## CLI

```bash
export CLAVIS_API_ORIGIN=https://api.clavis.nexus
export CLAVIS_ID_ORIGIN=https://id.clavis.nexus
export CLAVIS_DEVELOPERS_ORIGIN=https://developers.clavis.nexus

clavis login
# After the passkey in the browser, paste the JSON from developers /setup/login
# Non-interactive: clavis login --bridge-json-file ./bridge.json
# Keep the token off the command line
clavis status
clavis org-anchor-plan example.com "Example Org" --incorporation JP --accept-customer-terms
# passkey, then org-anchor-finish, then publish DNS, then org-verify-anchor
clavis org-verify-anchor --domain example.com --nonce <nonce> --incorporation JP --accept-customer-terms
clavis card-checkout <orgId>
# Show the customer the consent statement in human.message, and continue only after they consent
clavis card-checkout <orgId> --consent-billing-data
clavis app-register --org <orgId> --host app.example.com --name "My App"
clavis app-host-plan <orgId> <appId>
clavis app-verify-host <orgId> <appId>
clavis declaration-set --org <orgId> --app <appId> --end-users "People on our team" --use signature="Approve"
clavis emit-env --app <appId>
# optional: narrow the regions that accept new connections
clavis app-regions-set <orgId> <appId> --regions JP
```

After `app-register`, the operate private key is saved at `~/.config/clavis/apps/<appId>/operate-private.jwk.json` (mode 0600). CLI and MCP JSON carry that file path.

`emit-env` writes `app.env` (mode 0600) in the same directory, and the response returns `env_file` and `shell` (for `source`). Set `CLAVIS_TRUST_ROOT` to Clavis's Master public JWK. The value is on docs.clavis.nexus. `emit-env` checks, with the verifier, that the trust documents on the trust surface chain to that key, then writes `CLAVIS_TRUST_ROOT` into `app.env` for `@clavis.nexus/app`'s `trustRoot`.

The session file is `~/.config/clavis/session.json` (`CLAVIS_SESSION_PATH` changes the path).

### Login (paste)

The browser does not POST the token to localhost. `clavis login` opens developers at `/developers/setup/login?state=…` and takes the page's JSON (`state` and `accessToken`) on stdin or with `--bridge-json-file`. Keep the access token and the operate private key off command-line arguments. MCP `clavis_login` opens the browser on the first call and takes `bridge_json` on the second. The operate key is read from the file `app-register` wrote.

### Creating an Org (place of incorporation and the organisation agreement)

`org-anchor-plan` and `org-verify-anchor` both take the following. In MCP the fields are `incorporation` and `accept_customer_terms`.

- `--incorporation`: the Org's place of incorporation. One of `JP`, `GB-EAW` (England and Wales), an EEA country code (for example `DE`), or `US-XX` (for example `US-DE`).
- `--accept-customer-terms`: records that the customer has agreed to the Customer Terms and the Data Processing Agreement (DPA) for this Org. Whether to agree is the customer's decision. Pass it after they agree. The CLI and MCP leave agreement off by default. An agent asks a person and does not set the flag itself. A response without it carries `needs_human: terms`.

A place of incorporation closed to new declarations right now (`closed_incorporations` on `GET /orgs/regions`) is refused by `org-anchor-plan` before the passkey. When the API returns 403 `REGION_CLOSED`, the response's `error` starts with `region_closed`.

### Declaring the place of incorporation again

After the Customer Terms and the DPA move to a new version, declare the place of incorporation again before a purchase.

```bash
clavis incorporation-set <orgId> --incorporation JP --accept-customer-terms
```

- A declaration binds to the Customer Terms and DPA versions current at that time. When the versions are newer, `incorporation.terms_current` in `clavis status` is `false`.
- Agreement to the new versions needs `--accept-customer-terms` (MCP: `clavis_incorporation_set`).
- Declaring the current place again continues even when that region is closed.

### Buying the signature card

After the passkey, signature-card checkout opens in the browser. A person enters the card.

```bash
clavis card-checkout <orgId>
# Show the customer the consent statement in human.message, and continue only after they consent
clavis card-checkout <orgId> --consent-billing-data
```

- The place of incorporation must already be declared against the current versions. When it is missing, `error` is `incorporation_required` or `incorporation_stale`.
- Payment and billing need the customer's own consent before checkout continues. Run the command once without `--consent-billing-data`. The response's `human.message` (`needs_human: terms`) carries the consent statement and the Customer Terms and DPA versions. Show that statement to the customer, and run again with `--consent-billing-data` (MCP: `consent_billing_data: true`) only after they consent. An agent does not set the flag itself.
- `--lang ja` shows the consent statement in Japanese (the default is English). The purchase record is tied to the statement in the language that was shown.
- `--offer bundle` buys the monthly bundle. The default is metered (`meter`).

### Regions an app accepts

Each app can narrow the countries and regions it takes new connections from. The setting is optional.

```bash
clavis app-regions-set <orgId> <appId> --regions JP,US
# back to every region Clavis accepts
clavis app-regions-set <orgId> <appId> --all
```

- The regions are `JP`, `US`, `GB` and `EEA`. In MCP, pass `regions` or `all: true` to `clavis_app_regions_set`.
- The choice is limited to regions Clavis accepts right now (`app_regions` on `GET /orgs/regions`). Any other region is refused before the passkey, and `error` starts with `region_not_open`.
- The region is the country the connection comes from. A connection whose country cannot be determined counts as outside the chosen regions.
- People who are already connected keep using the app. What stops is a new agreement, a first app connection, an account link, and a signature whose request names no signer.
- When the same regions are already saved, the command returns `unchanged: true` and does not open a passkey.
- An Org owner or admin can change the list. A stopped app cannot be changed.

### Agreements

What Connect shows when your app asks a user for an agreement comes from the app's agreement profile. Have Clavis snapshot your terms and privacy notice first, then set the profile with a passkey.

```bash
clavis app-lex-document <orgId> <appId> --url https://app.example.com/terms
# put the sha256 it returns in the profile's documents
clavis app-lex-profile-set <orgId> <appId> --file profile.json
# remove it
clavis app-lex-profile-set <orgId> <appId> --clear
```

- Clavis reads and normalises the profile, and returns the statement to sign (`org.app.lex_profile@1`). The CLI opens the passkey with that statement, then sets the same profile with the receipt. In MCP, use `clavis_app_lex_document` and `clavis_app_lex_profile_set`.
- A document not snapshotted first is refused before the passkey (`error` starts with `document_not_snapshotted`).

For a new App, add `--agreements` to `clavis app-register`, or set `agreements: true` in `clavis_app_register`.

### Exporting agreement records

```bash
clavis lex-counts <orgId> --query-file query.json
clavis lex-export <orgId> --request-file request.json
clavis lex-export-status <orgId> <jobId>
clavis lex-export-download <orgId> <jobId> --dir ./exports
```

- `request.json` is `{ "kind": "decisions" | "subject", "query": { ... }, "expiring_within_days": N, "records": true }`. `query` narrows by `from` and `to` (the period), `app_id`, `use_case`, `outcome`, `reason_code`, `pack_id`, `template`, `requirement`, `profile_version` and `params_version`. `expiring_within_days` keeps only records whose retention ends within that many days, so you can keep them yourself.
- Many people's records (`decisions`) need an owner's or admin's passkey over the request. One person's (`subject`, with `query.subject_ref`) does not. One export runs at a time, and holds up to 100,000 decisions.
- `lex-export-download` writes the files at mode 0600 under `<dir>/<jobId>/` — they hold people's records — after checking each file against the manifest and the manifest against the digest in the authenticated export status. An export is kept for 7 days.
- In MCP: `clavis_lex_counts`, `clavis_lex_export`, `clavis_lex_exports`, `clavis_lex_export_status` and `clavis_lex_export_download`.

### One person's agreement records

```bash
clavis lex-decision <orgId> <decisionId>
clavis lex-subject-decisions <orgId> <subject>
clavis lex-subject-erase <orgId> <subject>
```

- `subject` is the person's ID in your app (the `sub` you passed as `allowedSub`). `lex-decision` takes the `decisionId` your app received when the agreement completed.
- `lex-subject-erase` erases that person's decisions now, as your organisation's instruction for their erasure request. It needs an owner's or admin's passkey and cannot be undone. The leaves on your ledger stay and no longer lead to anything. While the records are under a hold, it is refused (`error` starts with `org_hold`) and nothing is erased.
- In MCP: `clavis_lex_decision`, `clavis_lex_subject_decisions` and `clavis_lex_subject_erase`.

### What this CLI covers

- `clavis status` returns the Org, apps, host confirmation, the use declaration, the app's accepted regions (`accepted_regions` only when the list is narrowed), the signature card (`signature_card_blockers` is what holds it back) and the place of incorporation. Check the ledger subscription on developers.
- `clavis card-checkout` opens checkout for the signature card. Subscribe to the ledger card on developers.
- `--use` on `declaration-set` accepts `signature` and `ledger`. The CLI takes one per run, and that declaration replaces the previous one. To declare more than one feature for one app, use the `uses` array in MCP, or developers.
- `clavis policy-bootstrap <orgId>` creates the Org policy, with a passkey. `app-register` runs it for you, so you need it on its own only when the policy is missing. A policy already in place returns `already_active: true` and opens no passkey.

## Library

```ts
import { createSetupClient } from "@clavis.nexus/setup";

const setup = createSetupClient();
const status = await setup.status();
```

When a tool response carries `needs_human: passkey | payment | dns | login | terms`, a person has to act. `terms` is an agreement only the customer can give: the Customer Terms, or providing data for a card checkout.

Registering a signature request and reading its completion are [`@clavis.nexus/app`](https://www.npmjs.com/package/@clavis.nexus/app).

## License

MIT. Copyright (c) 2026 DeepDive, Inc.
