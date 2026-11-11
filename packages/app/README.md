# `@clavis.nexus/app`

Server SDK for Node 24 and later (ESM). The browser preparation overlay is [`@clavis.nexus/app-shell`](https://www.npmjs.com/package/@clavis.nexus/app-shell).

A signature or a delegation is two relay calls. `sign` sends `POST /relay/v1/sign`. `completeSign` sends `POST /relay/v1/sign/complete` and returns the `receipt@2` string. The bundled verifier (`@clavis.nexus/collatio` 1.0.1) refuses that string with `receipt_type`. Store the string. That refusal is the verifier's answer.

## Install

```bash
npm install @clavis.nexus/app
```

Load it with `import`. Pass Clavis's Master public JWK as `trustRoot`. The value is on docs.clavis.nexus. `createAppClient` fails at construction when it is missing.

Receipts the bundled verifier accepts, delegation records and ledger proof bundles are checked with the Collatio verifier shipped in the SDK. The aggregate JWKS and the catalog come from the trust surface (`https://trust.clavis.nexus`), and the verifier checks that they chain to `trustRoot`. Passing the 2.x option `masterPublicJwkJson` throws `removed_option`.

## Sign

```ts
import { createAppClient, digestOf } from "@clavis.nexus/app";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

const app = createAppClient({
  apiOrigin: "https://api.clavis.nexus",
  appId: requiredEnv("CLAVIS_APP_ID"),
  operatePrivateJwk: requiredEnv("OPERATE_PRIVATE_JWK"),
  entityId: requiredEnv("CLAVIS_ENTITY_ID"),
  requestPrivateJwk: requiredEnv("REQUEST_PRIVATE_JWK"),
  trustRoot: requiredEnv("CLAVIS_TRUST_ROOT"),
});

const started = await app.sign({
  statement,
  signer,
  key: await digestOf(publicJwk),
});
// Give started.challenge to the authenticator. Keep started.envelope on the server.

const { receipt } = await app.completeSign({
  envelope: started.envelope,
  proof: { authenticator_data, client_data_json, signature },
});
```

`entityId` is `sha256:` and 43 unpadded Base64URL characters. `requestPrivateJwk` is an Ed25519 or P-256 private JWK. The protected header is only `{ alg, typ: "clavis-entity+jws", kid }`. `alg` is `EdDSA` or `ES256`. `kid` is the digest of the public JWK.

Claims are only `entity`, `htm`, `htu`, `body_sha256`, `iat`, `exp` and `jti`. `body_sha256` is the lowercase hex SHA-256 of the exact body bytes, and is omitted when there is no body. `exp - iat` is 60 seconds. `jti` is 22 unpadded Base64URL characters from 16 random bytes. `htu` lowercases the scheme and host and drops a default port.

The body is RFC 8785 canonical JSON. `sign` sends `{ statement, signer, suite: "webauthn.relayed@1", key }` and `link_lookup` when you set `linkLookup`. The answer is `{ envelope, dimension, challenge }`.

`completeSign` sends `{ envelope, proof }`. `envelope` on the wire is the digest of the envelope object. `proof` is `{ authenticator_data, client_data_json, signature }`. The success body is `{ receipt }`, and `receipt` contains `receipt@2`. The SDK returns that string. Request bodies and proof bytes stay out of logs.

`operatePrivateJwk` is an Ed25519 private JWK. Delegation use and ledger calls still sign with it (`Authorization: ClavisApp`).

## Delegation

Prepare terms with `prepareMandateTerms`. Put the normalised terms in the statement you pass to `sign`, then finish with `completeSign`. Labels are normalised to NFC, with runs of white space collapsed. Characters that change direction, and control characters, are refused. Operations and counterparties are reordered by identifier. The expiry is more than 5 minutes and at most 30 days after the request. Uses run from 1 to 1,000. Amounts are integers in the currency's minor unit (1 for yen, cents for a dollar).

Before each action within the terms, call `useMandate` so Clavis checks and counts it.

```ts
const { record } = await app.useMandate(mandateId, {
  operation: "invoice.pay",
  target: "vendor_a",
  amount: 30_000,
  agent: "https://agent.example/client",
  call: await mandateCallDigest({ invoice: "inv_123", amount: 30_000 }),
  use: useId,
});
```

`call` is the digest of the call you are about to make. A record (`mandate.use@1`) carries the request your app signed with the operate key (a JWT) and Clavis's countersignature (the `mandate-attest` key in the aggregate JWKS). `record` is the record string Clavis returned, as-is. `use` is the facts the verifier read from that record (`seq`, `operation`, `totals` and the rest). The SDK passes the record to the verifier, checks the countersignature and your app's JWT, and checks that the request in the record is the body you sent. When the response does not arrive, send again with the same `use` (a UUID). The same record comes back (`replayed: true`) and is counted once. When the uses or the amount run out, a close record comes back with it (`close`: the string and the facts).

Outside the terms is `mandate_outside`. `violations` lists why (`amount_total`, `uses`, `expired` and the rest). A revoked or ended delegation is `mandate_closed`.

| Call | What it returns |
|------|-----------------|
| `getMandate(id)` | The current state (`open` or `closed`), the running totals and the close record |
| `getMandateHistory(id)` | The full set of records. The verifier checks the grant receipt, the terms, the chain of uses and the close together |
| `listMandates({ sub, state })` | That user's delegations |
| `revokeMandate(id)` | Closes it from the app's side (reason `revoked_by_app`) |

Stored records can be checked again with `app.verifier.verifyMandateHistory({ grant, terms, uses, close })`. Pass the grant receipt, the use records and the close record as the strings you kept. Turn the terms into a string with `JSON.stringify(terms)`. A single record is `verifyMandateRecord(record, { app })`. That check accepts a delegation record under the mandate attestation key. The receipt key (`sign-receipt`) refuses it.

## Receipt

`completeSign` returns a holder receipt (`receipt@2`) as the string that arrived. Carry that string. Parsing it with `JSON.parse` and stringifying again collapses duplicate keys, and a later check can no longer refuse them.

Ask the bundled verifier to read that string and it refuses with `receipt_type`:

```ts
import { createVerifier } from "@clavis.nexus/app";

const verifier = createVerifier({ trustRoot: requiredEnv("CLAVIS_TRUST_ROOT"), apiOrigin: "https://api.clavis.nexus" });
await verifier.verifyReceipt(receipt);
// AppClientError code receipt_invalid, verifierReason receipt_type
```

The same verifier still answers a `receipt@1` or `receipt.app@1` string it already accepts. An app receipt (`receipt.app@1`) is Clavis's countersignature of a passkey signature from that shape. Carry and store it as a string.

```jsonc
{
  "type": "receipt.app@1",
  "statement": { "type": "app.sign@1", "request": "<requestId>", "app": "<app_id>", "digest": "<messageDigest>" },
  "envelope": {
    "suite": "webauthn@1",
    "dimension": "sha256:…",
    "aud": "request:<requestId>",
    "statement": "sha256:…",
    "signer": "<the user's ID in this app>",
    "rp": "clavis.nexus",
    "iat": 1791747759,
    "nonce": "…",
    "ext": { "shown@1": { "app": "<the app's display name>", "host": "<the app's host>", "action": "<displayHint>" } },
    "crit": ["shown@1"]
  },
  "proof": "sha256:…",
  "dimension": { "type": "dimension@1", "name": "app_sign", "verifier": "sha256:…", "registry": "sha256:…", "…": "…" },
  "attestations": [
    { "type": "accepted@1", "subject": "sha256:…", "at": 1791747761, "kid": "clavis-sign-receipt-k7mq", "alg": "ES256", "sig": "…" },
    { "type": "ledger.receipt@1", "note": "clavis.ledger.receipt/v1\nclavis.nexus/ledger/first-party.3\n…" }
  ]
}
```

`ledger.receipt@1` inside an attestation is the ledger's receipt for the receipt's mark — a commitment made from the binding and the proof digest — appended to a first-party shard of Clavis's ledger. The holder receipt `completeSign` returns is `receipt@2`.

After the SDK checks a receipt the verifier accepts, it fetches that shard's checkpoint from the trust surface and Clavis's inclusion proof (`GET {apiOrigin}/archive/ledger/<log>/proof`), and checks that the receipt's mark was appended to the ledger. The result is `anchor.state`.

| `anchor.state` | Meaning |
|----------------|---------|
| `anchored` | The receipt's mark is included in the trust surface's checkpoint (`size` and `time`) |
| `unanchored` | Still unchecked. `reason` is `pending` (waiting for the next checkpoint, about a minute), `unavailable` (the trust surface or the inclusion proof cannot be read) or `skipped` (`anchor: "skip"`) |

When the inclusion proof does not lead to the root of the trust surface's checkpoint, the error is `anchor_invalid`.

## Cloudflare Workers and similar runtimes

The SDK loads the bundled verifier on Node. On a runtime that cannot compile WASM at runtime (Cloudflare Workers, the Next.js Edge runtime and similar), pass a verifier compiled at build time in `verifiers`. Add `@clavis.nexus/collatio` at the version `@clavis.nexus/app` depends on.

```ts
import collatio from "@clavis.nexus/collatio/collatio.wasm";

const app = createAppClient({
  apiOrigin: "https://api.clavis.nexus",
  appId: env.CLAVIS_APP_ID,
  operatePrivateJwk: env.OPERATE_PRIVATE_JWK,
  entityId: env.CLAVIS_ENTITY_ID,
  requestPrivateJwk: env.REQUEST_PRIVATE_JWK,
  trustRoot: env.CLAVIS_TRUST_ROOT,
  verifiers: [{ digest: "sha256:…", module: collatio }],
});
```

`digest` is the digest of that `collatio.wasm`, given in the `@clavis.nexus/collatio` README (`moduleDigest` from `@clavis.nexus/collatio` computes it from the bytes). When a receipt the verifier accepts names a verifier the SDK does not hold, Node checks that it is in the catalog, fetches it from the trust surface, checks the hash and uses it. On other runtimes the error is `verifier_unavailable`.

## Errors

Failures are `AppClientError`. It carries `code`, the HTTP `status`, and `apiError` and `traceId` from the API.

| `code` | When |
|--------|------|
| `invalid_api_origin` | `apiOrigin` is not an https origin (stopped at construction) |
| `invalid_entity_id` | `entityId` is not `sha256:` and 43 unpadded Base64URL characters |
| `invalid_request_jwk` | `requestPrivateJwk` is not an Ed25519 or P-256 private JWK |
| `invalid_sign_input` | `statement`, `signer`, `key`, `envelope` or `proof` is the wrong shape. Stopped before sending, or the request URL cannot be signed |
| `sign_failed` | The relay refused the request. `apiError` holds the API's code |
| `invalid_sign_response` | The relay response is not `{ envelope, dimension, challenge }` or `{ receipt }` with a `receipt@2` string |
| `removed_option` | The 2.x option `masterPublicJwkJson` was passed (stopped at construction) |
| `invalid_trust_root` | `trustRoot` is not the Master public JWK (EC P-256), or the trust documents on the trust surface fail to chain to it |
| `invalid_trust_origin` | `apiOrigin` is not `api.<apex>`, and `trustOrigins` is absent (stopped at construction) |
| `trust_unavailable` | The trust documents cannot be read from the trust surface |
| `verifier_unavailable` | The receipt names a verifier this process lacks. Pass it in `verifiers` |
| `receipt_invalid` | The verifier refused the receipt. `verifierReason` holds the verifier's reason. For a `receipt@2` string that reason is `receipt_type` |
| `anchor_invalid` | The inclusion proof does not meet the root of the trust surface's checkpoint |
| `mandate_mismatch` | The grant receipt is not for this mandate of this app |
| `mandate_outside` | The use falls outside the terms. `violations` lists why |
| `mandate_closed` | The delegation was revoked, or has ended |
| `mandate_use_conflict` | The same `use` was sent with another body |
| `mandate_not_allowed` | Delegation is unavailable for this app |
| `invalid_mandate_record` | The verifier refused the record, or the record belongs to another delegation or another request |
| `ledger_bundle_invalid` | The verifier refused the ledger proof bundle |
| `network_error` | A fetch failed |

## Ledger

`commitLedger` makes a salt from the record and submits only the leaf. The handoff it returns includes the opening (salt and record). Give that opening to the other party in the transaction. The salt stays out of the request.

```ts
const handoff = await app.commitLedger({
  record: { asset: "a-1", to: "holder-2", at: "2026-10-09T00:00:00Z" },
  slotKey,
  assetId: "a-1",
  version: 1,
});
```

`slotKey` is a secret of 32 bytes or more. Use it so two values cannot be settled for the same version of the same asset. When you need no slot, pass `record` alone.

`commitLedger` has the verifier check the ledger receipt, and returns once the leaf reads as appended at that position.

After a checkpoint (about 60 seconds), `finishLedgerHandoff(handoff)` adds that opening to the proof bundle (`ledger.bundle@1`), has the verifier check it, and returns `{ bundle, facts }`. `bundle` is the string to hand over. `facts` is what the verifier checked (`log`, `index`, `committedBy`, `opening`, `anchor`). To wait for the anchor's timestamp proof, pass `{ waitForAnchor: true }`. The default wait is about 75 minutes.

Check a proof bundle you received with `createVerifier(...).verifyLedgerBundle(bundle)`. When there is an anchor, `facts.anchor.tsa` is the count of timestamp tokens that chain to a root in the verifier's registry. Certificate revocation is a separate check, left to the caller.

## License

MIT. Copyright (c) 2026 DeepDive, Inc.
