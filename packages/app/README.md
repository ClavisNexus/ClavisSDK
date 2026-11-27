# `@clavis.nexus/app`

Server SDK for Node 24 and later (ESM). The browser parts, the handoff shell and the Sign in with Clavis button, are [`@clavis.nexus/app-shell`](https://www.npmjs.com/package/@clavis.nexus/app-shell).

Pass a SHA-256 digest as Base64URL (43 characters) in `messageDigest`. The caller prepares that string. The user signs the statement `app.sign@1`, which Clavis builds from it, with a passkey. Store the registration response's `pollSecret` on your server, and read completion with `getStatus` or `waitForCompletion`. A completion carries an app receipt (`receipt.app@1`).

## Install

```bash
npm install @clavis.nexus/app
```

Load it with `import`. Pass Clavis's Master public JWK as `trustRoot`. The value is on docs.clavis.nexus. `createAppClient` fails at construction when it is missing.

Receipts, delegation records and ledger proof bundles are checked with the Collatio verifier shipped in the SDK. The aggregate JWKS and the catalog come from the trust surface (`https://trust.clavis.nexus`), and the verifier checks that they chain to `trustRoot`. Passing the 2.x option `masterPublicJwkJson` throws `removed_option`.

## Register

```ts
import { createAppClient } from "@clavis.nexus/app";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

const app = createAppClient({
  apiOrigin: "https://api.clavis.nexus",
  appId: requiredEnv("CLAVIS_APP_ID"),
  operatePrivateJwk: requiredEnv("OPERATE_PRIVATE_JWK"),
  trustRoot: requiredEnv("CLAVIS_TRUST_ROOT"),
});

type PollRecord = { pollSecret: string; messageDigest: string };

async function start(
  messageDigest: string,
  save: (requestId: string, record: PollRecord) => Promise<void>,
): Promise<Response> {
  const { requestId, pollSecret, consumeUrl } = await app.registerGenericSign({
    messageDigest,
    returnUrl: "https://console.example/done",
    displayHint: "Change billing account",
  });
  await save(requestId, { pollSecret, messageDigest });
  return Response.json({ consume_url: consumeUrl, request_id: requestId });
}
```

`save` writes to your session or key-value store. The JSON returned to the browser is `consume_url` and `request_id`. Leave `pollSecret` on the server.

`operatePrivateJwk` is an Ed25519 private JWK.

A request lives for 120 seconds by default. The user starts signing on Connect within that time. `ttlSeconds` sets it between 60 and 900 seconds. The cap is the setting on the app in developers (300 seconds by default). Going over it is `register_failed` (`apiError` is `REGISTRATION_TTL_TOO_LONG`).

`displayHint` is the one line (the operation) Connect shows before the signature. The line shown is part of the signature. To name one signer, pass that person's ID in this app as `allowedSub` (the OIDC `sub`, the same value as `sub` on completion).

## Completion

```ts
const completed = await app.waitForCompletion(requestId, pollSecret, {
  expectedMessageDigest: messageDigest,
});
```

`completed.state` is `"completed"`. The SDK fills `intentType`, `statementType` (`app.sign@1`), `messageDigest`, `sub`, `signedAt`, `receipt` and `anchor` from the receipt the verifier checked. `sub` is the user's ID in this app. It differs from app to app and is the same as the OIDC `sub`.

`receipt` is the receipt string Clavis returned, as-is. Store that string, and show it to the user or a third party.

To read once, call `getStatus(requestId, pollSecret, messageDigest)`. The third argument is the digest from registration. A completion whose digest differs is `AppClientError` with `digest_mismatch`. The binding `aud` has to be `request:<requestId>` for this request of this app. Any other binding is `receipt_invalid` or `status_request_mismatch`. When the verifier refuses the receipt, the error is `receipt_invalid` and `verifierReason` holds the verifier's reason.

`waitForCompletion` defaults to an interval of 2.5 seconds and `timeout` at 120 seconds. Fetches in flight while waiting are cut off at the same deadline. Passing `signal` ends the wait with `aborted`. Clavis allows 30 status reads a minute for one request. A read that hits the limit (HTTP 429) leaves the wait running, and the next reads are spaced further apart.

After the request lifetime, status is `status_failed` (HTTP `status` 404, `apiError` `NOT_FOUND`). A request whose signing has started stays readable for 15 minutes after completion.

## Webhook

```ts
async function onWebhook(
  body: unknown,
  load: (requestId: string) => Promise<{ pollSecret: string; messageDigest: string }>,
) {
  const ping = app.readWebhookPing(body);
  const record = await load(ping.requestId);
  return app.getStatus(ping.requestId, record.pollSecret, record.messageDigest);
}
```

`readWebhookPing` returns `event`, `requestId`, `intentType` and `state`. A ping carries no signature and no receipt. It asks you to read status. Read the completion with `getStatus` afterwards, and have the verifier check the receipt.

## Delegation

The user signs a set of terms once — operations, counterparties, amounts, uses, expiry and the actor — and your server or agent acts within them. Clavis refuses an action outside the terms. The user can revoke at any time under Delegations in their account.

```ts
const { requestId, pollSecret, consumeUrl, mandate } = await app.registerMandate({
  terms: {
    operations: [{ name: "invoice.pay", label: "Pay invoices" }],
    targets: [{ id: "vendor_a", label: "Acme Ltd" }],
    amount: { currency: "JPY", per_use: 50_000, total: 200_000 },
    uses: 10,
    not_after: Math.floor(Date.now() / 1000) + 14 * 86_400,
    agent: { id: "https://agent.example/client", label: "Payments agent" },
  },
  allowedSub: sub,
  returnUrl: "https://console.example/delegated",
});
// Store requestId, pollSecret and mandate on the server, and send the user to consumeUrl

const granted = await app.waitForMandate(requestId, pollSecret, mandate);
// Store granted.receipt (the grant's app receipt, as a string)
```

`label` is the name Connect shows the user. Labels are normalised to NFC, with runs of white space collapsed. Characters that change direction, and control characters, are refused. Operations and counterparties are reordered by identifier. The expiry is more than 5 minutes and at most 30 days after the request. Uses run from 1 to 1,000. Amounts are integers in the currency's minor unit (1 for yen, cents for a dollar). Only the person in `allowedSub` can sign.

Before each action within the terms, call `useMandate` so Clavis checks and counts it.

```ts
const { record } = await app.useMandate(mandate.id, {
  operation: "invoice.pay",
  target: "vendor_a",
  amount: 30_000,
  agent: "https://agent.example/client",
  call: await mandateCallDigest({ invoice: "inv_123", amount: 30_000 }),
  use: useId,
});
// Act on the payment once record comes back
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

## Agreements

Ask a user to agree to a step of your app — your terms, your privacy notice, marketing, sharing with a third party — on Connect, and check before an action that the agreement is in force and on today's terms. Clavis builds what the user is shown from your app's agreement profile (your documents, purposes and recipients, set with `@clavis.nexus/setup`: `app-lex-document` and `app-lex-profile-set`) and keeps the decision. Turn on “Agreements” under the app's allowed Intents first. A grant or a reconsent is signed with the user's passkey; a decline or a withdrawal is not.

```ts
const { requestId, pollSecret, consumeUrl, agreement } = await app.registerAgreement({
  useCase: "tos",
  allowedSub: sub,
  returnUrl: "https://console.example/agreed",
});
// Store requestId, pollSecret and agreement on the server, and send the user to consumeUrl

const decision = await app.waitForAgreement(requestId, pollSecret, agreement);
// decision.action is grant, reconsent or deny. Store decision.decisionId, and decision.receipt for a grant or a reconsent
```

`useCase` is one of `login`, `tos`, `privacy_ack`, `third_party_jp`, `third_party_foreign`, `sensitive_acquire`, `marketing` and `terminal`. `ceremony` is `grant` (the default), `reconsent` or `withdraw`. When the terms changed since the user agreed, a `grant` completes as a `reconsent`. Pass `ageBand` (and `ageMethod`, what it rests on) when your app knows the user's age band; otherwise the user states it on Connect.

A grant's or a reconsent's receipt is an app receipt with the statement `lex.agree@1` (`action`, `use_case`, and `shown`, the digest of the texts shown). The SDK has the verifier check it and checks that it answers the agreement you asked for.

Check the agreement on the server immediately before sending. A queued job uses the subject stored with that job and checks again on each retry.

```ts
async function dispatch(job) {
  try {
    await app.requireAgreement({
      sub: job.sub,
      useCase: "marketing",
      purposeId: "announcements",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    if (error instanceof AppClientError && error.code === "agreement_required") {
      return error.agreement; // "none" or "reconsent_required". Leave the message unsent.
    }
    throw error; // Hold the job. Retry from the agreement check.
  }
  await mailer.deliver(job.message, { idempotencyKey: job.id });
}
```

`agreementState({ sub, useCase, purposeId })` reads the current state. Omit `purposeId` to check all applicable purposes. The result is `{ state: "none" }` or `{ state: "open", decisionId, since, reconsentRequired }`. A failed lookup throws.

## On behalf of an organisation

Ask for a signature or a delegation on behalf of an organisation. Only a person designated as a signer for that organisation can sign, and the receipt's statement is `app.sign.on_behalf@1` (a delegation is `mandate.grant.on_behalf@1`). Turn on “Request on behalf of an organisation” under the app's allowed Intents. The signer's organisation needs no Clavis plan.

```ts
const { requestId, pollSecret, consumeUrl, onBehalf } = await app.registerGenericSign({
  messageDigest,
  displayHint: "Approve purchase order",
  onBehalf: { domain: "supplier.example" },
});
// Store requestId, pollSecret, messageDigest and onBehalf on the server

const completed = await app.waitForCompletion(requestId, pollSecret, {
  expectedMessageDigest: messageDigest,
  expectedOnBehalf: onBehalf,
});
// completed.onBehalf is { org, domain }
```

`domain` is a domain the organisation confirmed in Clavis through DNS. Send it lowercased, with a trailing dot dropped. The `onBehalf` in the registration result is that form. Pass internationalised domains in Punycode (`xn--`).

When you read the completion, pass the registration result's `onBehalf` as `expectedOnBehalf`. With it, the SDK checks that the receipt was made on behalf of that organisation's domain. Without it, the SDK checks that the receipt names no organisation. A mismatch is `on_behalf_mismatch`.

`completed.onBehalf.org` is the organisation's ID in Clavis. It stays the same if the domain changes. The receipt shows that Clavis confirmed, at completion, that the person who signed was designated as a signer for that organisation.

A delegation is `registerMandate({ …, onBehalf: { domain } })`. The result's `mandate` includes `onBehalf`, and `waitForMandate` checks it. When the signer designation ends, the delegation closes (close record `mandate.close@1`, reason `signer_designation_ended`). Only a delegation granted on behalf of an organisation closes with this reason.

## Receipt

An app receipt (`receipt.app@1`) is Clavis's countersignature that it accepted the user's passkey signature. Carry and store the receipt as a string. Parsing it with `JSON.parse` collapses duplicate keys into one, and the verifier can no longer refuse them.

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

`envelope.ext["shown@1"]` is the app name, host and operation the user saw just before signing. `ledger.receipt@1` is the ledger's receipt for the receipt's mark — a commitment made from the binding and the proof digest — appended to a first-party shard of Clavis's ledger.

After the SDK checks the receipt, it fetches that shard's checkpoint from the trust surface and Clavis's inclusion proof (`GET {apiOrigin}/archive/ledger/<log>/proof`), and checks that the receipt's mark was appended to the ledger. The result is `anchor.state`.

| `anchor.state` | Meaning |
|----------------|---------|
| `anchored` | The receipt's mark is included in the trust surface's checkpoint (`size` and `time`) |
| `unanchored` | Still unchecked. `reason` is `pending` (waiting for the next checkpoint, about a minute), `unavailable` (the trust surface or the inclusion proof cannot be read) or `skipped` (`anchor: "skip"`) |

When the inclusion proof does not lead to the root of the trust surface's checkpoint, the error is `anchor_invalid`.

A stored receipt can be checked later, without the app's operate key.

```ts
import { createVerifier } from "@clavis.nexus/app";

const verifier = createVerifier({ trustRoot: requiredEnv("CLAVIS_TRUST_ROOT"), apiOrigin: "https://api.clavis.nexus" });
const verified = await verifier.verifyReceipt(storedReceipt, { expect: { aud: `request:${requestId}` } });
// verified.statement, verified.envelope, verified.anchor
```

The proof is a digest (`holderProof`), carried so it can be matched against the holder's own receipt. The app receipt holds that digest in place of a passkey public key or credential ID.

## Cloudflare Workers and similar runtimes

The SDK loads the bundled verifier on Node. On a runtime that cannot compile WASM at runtime (Cloudflare Workers, the Next.js Edge runtime and similar), pass a verifier compiled at build time in `verifiers`. Add `@clavis.nexus/collatio` at the version `@clavis.nexus/app` depends on.

```ts
import collatio from "@clavis.nexus/collatio/collatio.wasm";

const app = createAppClient({
  apiOrigin: "https://api.clavis.nexus",
  appId: env.CLAVIS_APP_ID,
  operatePrivateJwk: env.OPERATE_PRIVATE_JWK,
  trustRoot: env.CLAVIS_TRUST_ROOT,
  verifiers: [{ digest: "sha256:…", module: collatio }],
});
```

`digest` is the digest of that `collatio.wasm`, given in the `@clavis.nexus/collatio` README (`moduleDigest` from `@clavis.nexus/collatio` computes it from the bytes). When the receipt names a verifier the SDK does not hold, Node checks that it is in the catalog, fetches it from the trust surface, checks the hash and uses it. On other runtimes the error is `verifier_unavailable`.

## Sign in with Clavis

Sign the user in on your server, and receive their ID in this app (`sub`) before their first signature.

```ts
import type { PendingSignIn } from "@clavis.nexus/app";

// Called by the button (@clavis.nexus/app-shell) when the user presses it
async function startSignIn(keep: (pending: PendingSignIn) => Promise<void>): Promise<Response> {
  const { url, pending } = await app.beginSignIn({
    redirectUri: "https://console.example/auth/clavis/callback",
    scope: ["profile"],
    uiLocales: ["ja"],
  });
  await keep(pending);
  return Response.json({ url });
}

// GET /auth/clavis/callback
async function callback(request: Request, take: () => Promise<PendingSignIn>) {
  const { iss, sub, name, tokens } = await app.completeSignIn(request.url, await take());
  // Find or create the account keyed by (iss, sub), and start your own session
}
```

`redirectUri` is one of the app's redirect paths in developers, as an https URL under the app's host. `beginSignIn` sends nothing. `pending` holds `state`, `nonce` and the PKCE code verifier. Keep it in your server-side session, not in a URL or in a cookie the browser can read, and delete it once `completeSignIn` has used it. The URL carries only `state`, `nonce` and the code challenge.

`completeSignIn` takes the URL the user came back on, or its query. It checks `state`, exchanges the code with the verifier, and checks the id_token: ES256 under a sign-in key (slot `oidc-id-token` or `wauthn-auth-jwt`) of the aggregate JWKS that chains to `trustRoot`, `iss` (`apiOrigin`), `aud` (`appId`, alone), `nonce`, `exp`, `iat` (issued within the last 5 minutes) and `at_hash`.

`sub` is the user's ID in this app. Pass it as `allowedSub` when you register a signature request or a delegation, and only that person can sign. It is the `sub` a completion returns. Key accounts by `iss` and `sub` together.

| `scope` | What you receive |
|---------|------------------|
| (always `openid`) | `sub` |
| `profile` | `name`, when the user set one |
| `org.role` | The user's role in the Org that owns this app, read with `orgMembership` |

Email and contact details are not passed. When you need them, ask the user after sign-in.

When Clavis sends the user back with a refusal, or refuses the exchange, the error is one of two codes. Show your other ways in for both.

| `code` | When |
|--------|------|
| `declined` | The user did not sign in (`access_denied`). Clavis gives no reason |
| `unavailable` | Sign-in is not open to this app now (`unauthorized_client`), or the code exchange was refused. `status`, `apiError` and `traceId` carry what the token endpoint said |

Keep the tokens on your server.

```ts
const next = await app.refreshSignIn({ refreshToken, sub });
// Keep next.tokens.refreshToken: a refresh turns the refresh token over

const membership = await app.orgMembership(tokens.accessToken);
// { sub, appId, orgId, orgRole: "owner" | "admin" | "member" | null }

await app.revokeSignIn(refreshToken, { tokenTypeHint: "refresh_token" });

const signOut = app.endSessionUrl({ postLogoutRedirectUri: "https://console.example/signed-out", idTokenHint: tokens.idToken });
```

`refreshSignIn` checks the new id_token as above and that it names the same `sub`. A refused refresh (the user revoked the app from their Clavis account, or the session ended) is `unavailable`. End your app session before redirecting to the URL from `endSessionUrl`. The user can confirm sign-out on Clavis and return to your registered URL. They can also close the page.

## Link your Clavis account

Link the Clavis account of a user already signed in to your app, and receive their ID in this app (`sub`).

```ts
import type { PendingLink } from "@clavis.nexus/app";

async function startLink(localUserId: string, keep: (pending: PendingLink) => Promise<void>): Promise<Response> {
  const { consumeUrl, displayCode, pending } = await app.registerLink({
    appUser: localUserId,
    returnUrl: "https://console.example/settings/clavis",
    ttlSeconds: 300,
  });
  await keep(pending);
  return Response.json({ consume_url: consumeUrl, display_code: displayCode });
}

// When the user comes back to returnUrl, or on the webhook ping
async function linked(take: () => Promise<PendingLink>) {
  const { iss, sub, appUser, receipt } = await app.completeLink(await take());
  // Store (iss, sub) ↔ appUser, and the receipt
}
```

In the browser, show `display_code` on your own page first, then hand over to Connect with the handoff shell when the user continues. Connect asks the user to type the code before they sign.

```ts
import { openHandoffShell } from "@clavis.nexus/app-shell";
import "@clavis.nexus/app-shell/styles.css";

const res = await fetch("/api/clavis/link", { method: "POST", credentials: "same-origin" });
const { consume_url, display_code } = (await res.json()) as { consume_url: string; display_code: string };
showConfirmationCode(display_code); // your page: the code, and a button to continue to Clavis

async function continueToClavis() {
  await openHandoffShell({ allowedConsumeHosts: ["api.clavis.nexus"], register: async () => consume_url });
}
```

The user signs `federation.link@1 { app, app_user, nonce, iss }` with a passkey on Connect. `appUser` is your own ID for the user, normalised to NFC with the ends trimmed (at most 128 characters, no control characters). The SDK makes the nonce and names the issuer. The request lives for `ttlSeconds` (120 seconds by default), so the user has to reach Connect within it. Pass `allowedSub` when you already know the user's ID in this app.

`completeLink` reads status with the poll secret in `pending`. Before the user has signed, it is `link_pending`. The verifier checks the app receipt, and the SDK checks that it binds `appUser`, the nonce and the issuer you asked for. Clavis keeps no table of links: the mapping is yours to keep.

## Errors

Failures are `AppClientError`. It carries `code`, the HTTP `status`, and `apiError` and `traceId` from the API.

| `code` | When |
|--------|------|
| `invalid_api_origin` | `apiOrigin` is not an https origin (stopped at construction) |
| `register_failed` | Registration was refused. `apiError` holds the API's code |
| `invalid_register_response` | The register response has the wrong shape. The same code covers a `consume_url` whose origin differs from `apiOrigin` |
| `invalid_message_digest` | `messageDigest` is not SHA-256 as Base64URL (43 characters). Stopped before sending |
| `invalid_ui_locales` | `uiLocales` is not a list of language tags. Stopped before sending |
| `digest_mismatch` | The digest in the completion differs from the digest at registration |
| `removed_option` | The 2.x option `masterPublicJwkJson` was passed (stopped at construction) |
| `invalid_trust_root` | `trustRoot` is not the Master public JWK (EC P-256), or the trust documents on the trust surface fail to chain to it |
| `invalid_trust_origin` | `apiOrigin` is not `api.<apex>`, and `trustOrigins` is absent (stopped at construction) |
| `trust_unavailable` | The trust documents cannot be read from the trust surface |
| `verifier_unavailable` | The receipt names a verifier this process lacks. Pass it in `verifiers` |
| `status_request_mismatch` | The status or the receipt belongs to another `requestId`, or to another app |
| `receipt_invalid` | The verifier refused the receipt. `verifierReason` holds the verifier's reason |
| `anchor_invalid` | The inclusion proof does not meet the root of the trust surface's checkpoint |
| `invalid_mandate_terms` | The terms break a rule. Stopped before sending. The reason is `shape`, `label`, `duplicate` or `lifetime` |
| `mandate_terms_mismatch` | The terms in the register response differ from the normalised terms you sent |
| `mandate_mismatch` | The grant receipt binds a delegation ID or terms other than the ones you requested |
| `mandate_outside` | The use falls outside the terms. `violations` lists why |
| `mandate_closed` | The delegation was revoked, or has ended |
| `mandate_use_conflict` | The same `use` was sent with another body |
| `mandate_not_allowed` | Delegation is unavailable for this app (Intent type, the signature declaration, the subscription) |
| `invalid_mandate_record` | The verifier refused the record, or the record belongs to another delegation or another request |
| `invalid_on_behalf` | `onBehalf.domain` is not a domain name. Stopped before sending |
| `on_behalf_mismatch` | The completion receipt names an organisation other than the one you asked for. A receipt that names an organisation when the request named none is `invalid_status` |
| `declined` | The user did not sign in (`access_denied` on the return) |
| `unavailable` | Sign-in is not open to this app now (`unauthorized_client` or another error on the return), or the token endpoint refused the exchange or the refresh |
| `invalid_sign_in_args` | `redirectUri` is not https, `scope` lists something else, or `pending` is not what `beginSignIn` returned. Stopped before sending |
| `state_mismatch` | The return does not carry the `state` this sign-in started with. Nothing is sent |
| `invalid_callback` | The return carries neither `code` nor `error`, or names another issuer |
| `invalid_token_response` | The token response lacks the tokens |
| `id_token_invalid` | The id_token failed a check. The message names it (`signature`, `kid`, `iss`, `aud`, `exp`, `iat`, `nonce`, `sub`, `at_hash`) |
| `revoke_failed` | The revocation endpoint refused |
| `org_membership_failed` | The Org membership endpoint refused (an expired access token is HTTP 401; a sign-in without `org.role` is 403 `INSUFFICIENT_SCOPE`) |
| `invalid_org_membership` | The Org membership answer has the wrong shape, or is for another app |
| `invalid_app_user` | `appUser` is not 1 to 128 characters of text. Stopped before sending |
| `link_pending` | The link has not been signed yet |
| `link_mismatch` | The completed receipt is not a link, or binds another user, nonce or issuer |
| `invalid_agreement` | `useCase`, `ceremony`, `ageBand` or `ageMethod` is not one Clavis takes, or `ageMethod` comes without `ageBand`. Stopped before sending |
| `agreement_mismatch` | The completion answers another step, another action, or a receipt that is not `lex.agree@1` |
| `agreement_required` | `requireAgreement` found no agreement in force (`agreement` is `none`), or one given on changed terms (`reconsent_required`) |
| `agreement_state_failed` | The agreement state was not read. `apiError` holds the API's code |
| `invalid_agreement_state` | The agreement state has the wrong shape |
| `timeout` | `waitForCompletion` reached its deadline |
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

## Screen language

To line Connect's confirmation screen up with your app's language, pass BCP 47 language tags in `uiLocales`, in order of preference. Use the language you wrote `displayHint` in.

```ts
await app.registerGenericSign({
  messageDigest,
  returnUrl: "https://console.example/done",
  displayHint: "管理者権限の付与",
  uiLocales: ["ja"],
});
```

Connect chooses from the languages it has open, in this order. It skips a language it has closed. When none of the tags are open, it uses the user's choice and the browser's language. Omitting `uiLocales` follows the same rule.

## License

MIT. Copyright (c) 2026 DeepDive, Inc.
