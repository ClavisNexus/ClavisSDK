import {
  appDisabledRefusal,
  appRegionsRefusal,
  readAppRegionsInput,
  regionNotOpenRefusal,
  sameAppRegions,
  type AppRegion,
} from "./app-regions.js";
import { openBrowser } from "./browser.js";
import {
  billingConsentHuman,
  checkoutLang,
  checkoutRefusal,
  declarationRegionClosedRefusal,
  incorporationNeededRefusal,
  incorporationSetRefusal,
  purchaseRegionClosedRefusal,
  type CardCheckoutOptions,
} from "./card.js";
import { assertCardCheckoutBrowserUrl, assertOriginBrowserUrl } from "./safe-browser-url.js";
import {
  buildAnchorTxtRecord,
  hashManifestBody,
  orgAnchorPublishStatement,
  orgAppDeclarationStatement,
  orgAppRegionsStatement,
  orgAppRegisterStatement,
  orgPayloadDigest,
  orgAppVerifyHostStatement,
  orgCardCheckoutStatement,
  orgCardIncorporationStatement,
  orgLexSubjectEraseStatement,
  orgPolicyBootstrapStatement,
  sameStatement,
  type Statement,
} from "./statements.js";
import {
  ceremonyPageUrl,
  pollCeremonyResult,
  receiptFromCeremonyPayload,
  setupCeremonyReturnTo,
  startCeremony,
} from "./ceremony.js";
import { emitAppEnv } from "./emit-env.js";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { bytesToBase64Url } from "./base64url.js";
import { saveOperatePrivateJwk, readOperatePrivateJwk } from "./operate-key-store.js";
import { generateOperateKeyPair } from "./keys.js";
import { loginWithBrowser } from "./login.js";
import * as api from "./org-api.js";
import {
  checkOrgCreationTerms,
  INCORPORATION_TERMS_HUMAN,
  orgCreationRefusal,
  regionClosedRefusal,
  type OrgCreationTerms,
} from "./org-creation.js";
import { clearSession, loadSession, originsFromEnv, type StoredSetupSession } from "./session-store.js";
import { buildSetupStatus } from "./status.js";
import type {
  DevelopersSession,
  DnsChallenge,
  HumanAction,
  OrgCardIncorporation,
  SetupOrigins,
  SetupResult,
  Receipt,
  SetupStatusReport,
} from "./types.js";

export type CreateSetupClientOptions = {
  origins?: Partial<SetupOrigins>;
  sessionPath?: string;
  /** When false, do not call the OS browser opener (still return open_url). */
  openBrowser?: boolean;
};

export type SetupClient = {
  origins: SetupOrigins;
  getSession(): Promise<DevelopersSession | null>;
  login(opts?: { bridgeJson?: string }): Promise<SetupResult<{ sub?: string; pending?: true }>>;
  logout(): Promise<SetupResult<{ cleared: true }>>;
  status(): Promise<SetupResult<SetupStatusReport>>;
  /** terms: the place of incorporation, and the customer's agreement to the Customer Terms. With either missing, or the place closed, it is refused before the passkey. */
  orgAnchorPlan(domain: string, name?: string, terms?: OrgCreationTerms): Promise<
    SetupResult<{
      domain: string;
      name?: string;
      incorporation: string;
      nonce: string;
      exp: number;
      /** The statement signed into the published manifest's `receipt` (`org.anchor.publish@1`) */
      statement: Statement;
      well_known_url: string;
      txt_host: string;
      ceremony_url: string;
      human: HumanAction;
      ticket: string;
    }>
  >;
  orgAnchorFinish(args: {
    domain: string;
    nonce: string;
    exp: number;
    ticket: string;
    well_known_url: string;
    txt_host: string;
  }): Promise<
    SetupResult<{
      well_known_json: string;
      well_known_url: string;
      txt_host: string;
      txt_value: string;
      human: HumanAction;
    }>
  >;
  orgVerifyAnchor(
    args: {
      domain: string;
      nonce: string;
      name?: string;
    } & OrgCreationTerms,
  ): Promise<SetupResult<{ org_id: string; org_status: string }>>;
  policyBootstrap(orgId: string): Promise<SetupResult<{ policy_revision_hash: string; already_active: boolean }>>;
  /**
   * Declare the place of incorporation, with a passkey. The declaration binds the current Customer
   * Terms and DPA versions, so it needs the customer's agreement. After those versions move, declare
   * again before a purchase.
   */
  incorporationSet(
    args: { orgId: string } & OrgCreationTerms,
  ): Promise<SetupResult<{ incorporation: OrgCardIncorporation | null; unchanged?: true }>>;
  /**
   * Open checkout for the signature card. It needs a place of incorporation declared against the
   * current versions, and the customer's consent to provide billing data. After the passkey, a person
   * enters the card in the browser.
   */
  cardCheckout(orgId: string, opts?: CardCheckoutOptions): Promise<SetupResult<{ url: string; human: HumanAction }>>;
  appRegister(args: {
    orgId: string;
    host: string;
    displayName: string;
    redirectPaths?: string[];
    intentTypes?: string[];
  }): Promise<
    SetupResult<{
      app_id: string;
      host: string;
      operate_private_jwk_path: string;
      human: HumanAction;
    }>
  >;
  appHostPlan(orgId: string, appId: string): Promise<
    SetupResult<{
      host: string;
      txt_record_name: string;
      txt_value: string;
      human: HumanAction;
    }>
  >;
  appVerifyHost(args: {
    orgId: string;
    appId: string;
  }): Promise<SetupResult<{ status: string; human?: HumanAction }>>;
  declarationSet(args: {
    orgId: string;
    appId: string;
    endUsers: string;
    uses: { capability: string; operation: string }[];
  }): Promise<SetupResult<{ declaration: unknown }>>;
  /**
   * Choose the regions the app accepts new connections from, with a passkey. Null goes back to every
   * region Clavis accepts. The choice is limited to the regions Clavis accepts right now. Narrowing
   * the list leaves the people already connected using the app.
   */
  appRegionsSet(args: {
    orgId: string;
    appId: string;
    regions: readonly string[] | null;
  }): Promise<SetupResult<{ accepted_regions: AppRegion[] | null; unchanged?: true }>>;
  /**
   * Have Clavis take a snapshot of the org's terms or privacy notice, from the app's confirmed host or the org's
   * domain. The agreement profile names the document by the snapshot's SHA-256
   */
  appLexDocument(args: { orgId: string; appId: string; url: string }): Promise<SetupResult<Record<string, unknown>>>;
  /**
   * Set the app's agreement profile (what Connect shows when the app asks for an agreement), or clear it with null,
   * with a passkey. Clavis reads and normalises the profile, and tells this tool what to sign
   */
  appLexProfileSet(args: { orgId: string; appId: string; profile: unknown }): Promise<SetupResult<{ app_id: string; lex_profile: unknown }>>;
  /** How many agreement decisions a query matches, by outcome, stop reason and pack */
  lexCounts(args: { orgId: string; query?: unknown }): Promise<SetupResult<Record<string, unknown>>>;
  /**
   * Start an export of agreement decisions. Many people's decisions (`kind: "decisions"`) need an owner's or admin's
   * passkey over the request; one person's (`kind: "subject"`) does not
   */
  lexExport(args: { orgId: string; request: unknown }): Promise<SetupResult<{ job: Record<string, unknown> }>>;
  lexExports(args: { orgId: string }): Promise<SetupResult<{ jobs: unknown[] }>>;
  lexExportStatus(args: { orgId: string; jobId: string }): Promise<SetupResult<{ job: Record<string, unknown>; anchor?: unknown }>>;
  /**
   * Fetch a finished export into `dir/<jobId>/` (files at mode 0600: they hold people's records), checking each file
   * against the manifest's digest and the manifest against the digest in the authenticated status
   */
  lexExportDownload(args: {
    orgId: string;
    jobId: string;
    dir: string;
  }): Promise<SetupResult<{ dir: string; manifest_digest: string; files: { path: string; bytes: number }[] }>>;
  /** One agreement decision: its record, its ledger proof and where it stands now (`lifecycle`) */
  lexDecision(args: { orgId: string; decisionId: string }): Promise<SetupResult<Record<string, unknown>>>;
  /** Every agreement decision the org holds for one person (their ID in the org's apps), to answer that person's request */
  lexSubjectDecisions(args: { orgId: string; subject: string }): Promise<SetupResult<Record<string, unknown>>>;
  /**
   * Erase one person's agreement decisions now, with an owner's or admin's passkey: the org's instruction, for that
   * person's erasure request. The ledger leaves stay and no longer lead to anything. It cannot be undone
   */
  lexSubjectErase(args: { orgId: string; subject: string }): Promise<SetupResult<{ erased: number; decision_ids: string[] }>>;
  emitEnv(args: {
    appId: string;
    operatePrivateJwkJson?: string;
  }): Promise<
    SetupResult<{
      env_file: string;
      operate_private_jwk_path: string;
      public_env: { CLAVIS_API_ORIGIN: string; CLAVIS_APP_ID: string };
      shell: string;
    }>
  >;
};

type RequireSession = { session: DevelopersSession; origins: SetupOrigins };

/** A person's ID in the org's apps, as Clavis takes it */
const LEX_SUBJECT = /^[A-Za-z0-9._:-]{1,128}$/;
const LEX_DECISION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The paths a finished export holds (the manifest names them) */
const LEX_EXPORT_PATH = /^(manifest\.json|anchor\.json|items\/\d{5}\.jsonl|decisions\/[A-Za-z0-9._:-]{1,128}\.json)$/;

async function bytesDigest(bytes: Uint8Array): Promise<string> {
  return `sha256:${bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))))}`;
}

/** Turn the API's reasons for refusing an agreement profile or an export into wording that says what happened. Anything else is null */
function lexRefusal(e: unknown): { ok: false; error: string } | null {
  if (!(e instanceof api.SetupApiError)) return null;
  switch (e.code) {
    case "PROFILE_INVALID":
      return { ok: false, error: "profile_invalid — the agreement profile is incomplete (version, service_name, purposes, destinations and terminal_categories are required)." };
    case "DOCUMENT_NOT_SNAPSHOTTED":
      return { ok: false, error: "document_not_snapshotted — run app-lex-document for each document in the profile first, and use the sha256 it returns." };
    case "EXPORT_RUNNING":
      return { ok: false, error: "export_running — another export of this organisation is running. Wait for it, then start again." };
    case "EXPORT_TOO_LARGE":
      return { ok: false, error: "export_too_large — more decisions match than one export holds. Narrow the period (query.from, query.to) and start again." };
    case "FORBIDDEN":
      return { ok: false, error: "forbidden — only an owner or admin of the Org can do this." };
    case "NOT_FOUND":
      return { ok: false, error: "not_found — the Org, the App, the export or the decision was not found, or this is not open to the Org yet." };
    case "ORG_HOLD":
      return { ok: false, error: "org_hold — these records are preserved under a hold, so erasure waits until the hold ends. Nothing was erased." };
    default:
      return null;
  }
}

/** The saved session and the origins it was saved with (`saveSession` always writes both) */
async function requireSession(sessionPath?: string): Promise<SetupResult<RequireSession>> {
  const stored = await loadSession(sessionPath);
  if (!stored?.session?.accessToken) {
    return {
      ok: false,
      error: "not_logged_in",
      human: {
        needs_human: "login",
        message: "Run clavis_login / `clavis login` and complete Passkey in the browser.",
      },
    };
  }
  return { ok: true, data: { session: stored.session, origins: stored.origins } };
}

/**
 * Send the person back to id to sign the statement with a passkey, and wait for the receipt.
 * What the screen shows is the statement's type ID, never wording from the caller; `human.message` is
 * what tells the person which step they are on.
 */
async function runPasskeyCeremony(args: {
  origins: SetupOrigins;
  bearer: string;
  statement: Statement;
  /** The description of the step shown to the person. It is never sent to Clavis */
  displayHint?: string;
  openBrowserFlag: boolean;
}): Promise<{ ticket: string; ceremony_url: string; human: HumanAction; wait: () => Promise<Receipt> }> {
  const returnTo = setupCeremonyReturnTo(args.origins.developersOrigin);
  const { ticket } = await startCeremony({
    apiOrigin: args.origins.apiOrigin,
    bearer: args.bearer,
    returnTo,
    statement: args.statement,
  });
  const ceremony_url = assertOriginBrowserUrl(ceremonyPageUrl(args.origins.idOrigin, ticket), args.origins.idOrigin);
  if (args.openBrowserFlag) {
    try {
      await openBrowser(ceremony_url);
    } catch {
      // URL still returned
    }
  }
  const human: HumanAction = {
    needs_human: "passkey",
    message: `${args.displayHint ? `${args.displayHint}: c` : "C"}onfirm with Passkey in the browser (${args.statement.type}), then return to the terminal/agent.`,
    open_url: ceremony_url,
  };
  return {
    ticket,
    ceremony_url,
    human,
    wait: async () => {
      const payload = await pollCeremonyResult({
        apiOrigin: args.origins.apiOrigin,
        bearer: args.bearer,
        ticket,
      });
      return receiptFromCeremonyPayload(payload);
    },
  };
}

export function createSetupClient(options: CreateSetupClientOptions = {}): SetupClient {
  const origins = originsFromEnv(options.origins);
  const openBrowserFlag = options.openBrowser !== false;
  const sessionPath = options.sessionPath;

  const client: SetupClient = {
    origins,

    async getSession() {
      const s = await loadSession(sessionPath);
      return s?.session ?? null;
    },

    async login(opts?: { bridgeJson?: string }) {
      const bridgeJson = opts?.bridgeJson?.trim();
      // MCP / non-TTY: first call opens the browser; second call supplies bridge_json.
      const deferPaste = !bridgeJson && !process.stdin.isTTY;
      const out = await loginWithBrowser({
        origins,
        open: openBrowserFlag,
        ...(bridgeJson ? { bridgeJson } : {}),
        ...(deferPaste ? { deferPaste: true } : {}),
        sessionPath,
      });
      if (out.pending || !out.session) {
        return {
          ok: false as const,
          error: "login_pending_paste",
          human: out.human,
        };
      }
      return { ok: true as const, data: { sub: out.session.sub } };
    },

    async logout() {
      await clearSession(sessionPath);
      return { ok: true, data: { cleared: true } };
    },

    async status() {
      const session = await client.getSession();
      const report = await buildSetupStatus({ origins, session });
      return { ok: true, data: report };
    },

    async orgAnchorPlan(domain, name, terms = {}) {
      const checked = checkOrgCreationTerms(terms);
      if (!checked.ok) return checked;
      const { incorporation } = checked;
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const apiOrigin = auth.data.origins.apiOrigin;
      // A closed place of incorporation is refused before the passkey; when the list cannot be read, the challenge's own gate decides.
      const closed = await api.getClosedIncorporations(apiOrigin).catch(() => [] as string[]);
      if (closed.includes(incorporation)) return regionClosedRefusal(incorporation);
      let challenge: DnsChallenge;
      try {
        challenge = await api.postDnsChallenge(apiOrigin, auth.data.session.accessToken, { domain, incorporation });
      } catch (e) {
        const refusal = orgCreationRefusal(e, incorporation);
        if (refusal) return refusal;
        throw e;
      }
      const domainNorm = domain.trim().toLowerCase();
      if (
        !challenge.statement ||
        typeof challenge.domain !== "string" ||
        challenge.domain.trim().toLowerCase() !== domainNorm ||
        typeof challenge.nonce !== "string" ||
        challenge.nonce.length === 0 ||
        typeof challenge.exp !== "number" ||
        !Number.isFinite(challenge.exp)
      ) {
        return { ok: false, error: "challenge_missing_statement" };
      }
      // What gets signed is the statement built here: if it differs from the one Clavis returned, nothing is signed
      const anchorStatement = orgAnchorPublishStatement({ domain: domainNorm, nonce: challenge.nonce, exp: challenge.exp });
      if (!sameStatement(anchorStatement, challenge.statement)) return { ok: false, error: "challenge_statement_mismatch" };
      let wellKnown: URL;
      try {
        wellKnown = new URL(challenge.well_known_url);
      } catch {
        return { ok: false, error: "challenge_url_rejected" };
      }
      const txtHost = typeof challenge.txt_host === "string" ? challenge.txt_host.trim().toLowerCase().replace(/\.$/, "") : "";
      if (
        wellKnown.protocol !== "https:" ||
        wellKnown.username ||
        wellKnown.password ||
        wellKnown.hostname.toLowerCase() !== domainNorm ||
        (txtHost !== domainNorm && !txtHost.endsWith(`.${domainNorm}`))
      ) {
        return { ok: false, error: "challenge_url_rejected" };
      }
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer: auth.data.session.accessToken,
        statement: anchorStatement,
        displayHint: `Publish DNS anchor for ${domain}`,
        openBrowserFlag,
      });
      return {
        ok: true,
        data: {
          domain: challenge.domain,
          ...(name ? { name } : {}),
          incorporation,
          nonce: challenge.nonce,
          exp: challenge.exp,
          statement: anchorStatement,
          well_known_url: challenge.well_known_url,
          txt_host: challenge.txt_host,
          ceremony_url: cer.ceremony_url,
          human: cer.human,
          ticket: cer.ticket,
        },
      };
    },

    async orgAnchorFinish(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const payload = await pollCeremonyResult({
        apiOrigin: auth.data.origins.apiOrigin,
        bearer: auth.data.session.accessToken,
        ticket: args.ticket,
      });
      const receipt = receiptFromCeremonyPayload(payload);
      const body = {
        v: 1 as const,
        kind: "anchor" as const,
        domain: args.domain.trim().toLowerCase(),
        receipt,
        nonce: args.nonce,
        exp: args.exp,
        iat: Math.floor(Date.now() / 1000),
      };
      const bodyHash = await hashManifestBody(body);
      const well_known_json = JSON.stringify(body, null, 2);
      const txt_value = buildAnchorTxtRecord({ hash: bodyHash, nonce: args.nonce, exp: args.exp });

      return {
        ok: true,
        data: {
          well_known_json,
          well_known_url: args.well_known_url,
          txt_host: args.txt_host,
          txt_value,
          human: {
            needs_human: "dns",
            message:
              "Publish the well-known JSON and TXT, then call org_verify_anchor with the same incorporation and the customer's agreement to the Customer Terms.",
          },
        },
      };
    },

    async orgVerifyAnchor(args) {
      const checked = checkOrgCreationTerms(args);
      if (!checked.ok) return checked;
      const { incorporation } = checked;
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        const out = await api.postVerifyAnchor(auth.data.origins.apiOrigin, auth.data.session.accessToken, {
          domain: args.domain,
          nonce: args.nonce,
          name: args.name,
          incorporation,
          acceptCustomerTerms: args.acceptCustomerTerms,
        });
        return { ok: true, data: { org_id: out.org_id, org_status: out.org_status } };
      } catch (e) {
        const refusal = orgCreationRefusal(e, incorporation);
        if (refusal) return refusal;
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          human: {
            needs_human: "dns",
            message: "Publish apex TXT and well-known anchor JSON, then retry.",
          },
        };
      }
    },

    async policyBootstrap(orgId) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const detail = await api.getOrg(auth.data.origins.apiOrigin, auth.data.session.accessToken, orgId);
      try {
        const noop = await api.postPolicyBootstrap(
          auth.data.origins.apiOrigin,
          auth.data.session.accessToken,
          orgId,
        );
        if (noop.already_active) return { ok: true, data: noop };
      } catch {
        // With no policy yet, carry on to the passkey confirmation.
      }
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer: auth.data.session.accessToken,
        statement: orgPolicyBootstrapStatement({ org: orgId, domain: detail.primary_domain }),
        displayHint: `Bootstrap policy for ${detail.primary_domain}`,
        openBrowserFlag,
      });
      const proof = await cer.wait();
      const out = await api.postPolicyBootstrap(
        auth.data.origins.apiOrigin,
        auth.data.session.accessToken,
        orgId,
        proof,
      );
      return { ok: true, data: out };
    },

    async incorporationSet(args) {
      const checked = checkOrgCreationTerms(args, INCORPORATION_TERMS_HUMAN);
      if (!checked.ok) return checked;
      const code = checked.incorporation;
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const sub = auth.data.session.sub;
      if (!sub) return { ok: false, error: "session_missing_sub — re-login" };
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      const card = await api.getCard(apiOrigin, bearer, args.orgId);
      const current = card.incorporation;
      if (current?.code === code && current.terms_current) {
        return { ok: true, data: { incorporation: current, unchanged: true } };
      }
      // Declaring the current place again, to pick up new versions, carries on even where that region is closed.
      const closed = await api.getClosedIncorporations(apiOrigin).catch(() => [] as string[]);
      if (closed.includes(code) && current?.code !== code) return declarationRegionClosedRefusal(code);
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer,
        statement: orgCardIncorporationStatement({
          org: args.orgId,
          code,
          customerTerms: card.acceptance.customer_terms_version,
          dpa: card.acceptance.dpa_version,
        }),
        displayHint: `Declare ${code} as the place of incorporation`,
        openBrowserFlag,
      });
      const proof = await cer.wait();
      try {
        const out = await api.postCardIncorporation(apiOrigin, bearer, args.orgId, { code, receipt: proof });
        return { ok: true, data: { incorporation: out.incorporation } };
      } catch (e) {
        const refusal = incorporationSetRefusal(e, code);
        if (refusal) return refusal;
        throw e;
      }
    },

    async cardCheckout(orgId, opts = {}) {
      const offer = opts.offer === "bundle" ? "bundle" : "meter";
      const lang = checkoutLang(opts.lang);
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const sub = auth.data.session.sub;
      if (!sub) return { ok: false, error: "session_missing_sub — re-login" };
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      const card = await api.getCard(apiOrigin, bearer, orgId);
      if (card.suspended) return { ok: false, error: "org_suspended" };
      const signature = card.capabilities?.signature;
      const open = offer === "bundle" ? signature?.bundle_checkout_open : signature?.checkout_open;
      if (!signature || open !== true) {
        return { ok: false, error: "checkout_closed — the card checkout is not open right now." };
      }
      // Metered only while nothing is subscribed. The monthly bundle also takes a switch from metered.
      const blockers = signature.blockers ?? [];
      const subscribed = offer === "bundle" ? signature.tariff === "bundle" : !blockers.includes("subscription");
      if (subscribed) {
        const state = blockers.length > 0 ? ` (${blockers.join(", ")})` : "";
        return {
          ok: false,
          error: `already_subscribed — the signature card already has this subscription${state}. Manage it on developers.`,
        };
      }
      const incorporation = card.incorporation;
      if (!incorporation) return incorporationNeededRefusal(orgId, false);
      if (!incorporation.terms_current) return incorporationNeededRefusal(orgId, true);
      const closed = await api.getClosedIncorporations(apiOrigin).catch(() => [] as string[]);
      if (closed.includes(incorporation.code)) return purchaseRegionClosedRefusal(incorporation.code);
      if (opts.consentBillingData !== true) {
        return { ok: false, error: "billing_data_consent_required", human: billingConsentHuman(card.acceptance, lang) };
      }
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer,
        statement: orgCardCheckoutStatement({
          org: orgId,
          capability: "signature",
          offer,
          customerTerms: card.acceptance.customer_terms_version,
          dpa: card.acceptance.dpa_version,
        }),
        displayHint: offer === "bundle" ? "Subscribe to the signature card (monthly bundle)" : "Subscribe to the signature card",
        openBrowserFlag,
      });
      const proof = await cer.wait();
      let url: string;
      try {
        ({ url } = await api.postCardCheckout(apiOrigin, bearer, orgId, {
          capability: "signature",
          offer,
          consentBillingData: true,
          uiLocale: lang,
          receipt: proof,
        }));
      } catch (e) {
        const refusal = checkoutRefusal(e, { orgId, incorporation: incorporation.code });
        if (refusal) return refusal;
        throw e;
      }
      let checkoutUrl: string;
      try {
        checkoutUrl = assertCardCheckoutBrowserUrl(url);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "checkout_url_rejected" };
      }
      if (openBrowserFlag) {
        try {
          await openBrowser(checkoutUrl);
        } catch {
          // Even when the browser cannot be opened, the checked URL is still returned
        }
      }
      return {
        ok: true,
        data: {
          url: checkoutUrl,
          human: {
            needs_human: "payment",
            message: "Complete card checkout in the browser. Then poll clavis_setup_status.",
            open_url: checkoutUrl,
          },
        },
      };
    },

    async appRegister(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const sub = auth.data.session.sub;
      if (!sub) return { ok: false, error: "session_missing_sub — re-login" };

      await client.policyBootstrap(args.orgId);

      const keys = await generateOperateKeyPair();
      const paths = (args.redirectPaths ?? ["/done"]).map((p) => (p.startsWith("/") ? p : `/${p}`));
      const manifest = {
        v: 1 as const,
        host: args.host.trim().toLowerCase(),
        display_name: args.displayName.trim(),
        intent_types: args.intentTypes ?? ["generic_sign"],
        max_ttl_seconds: 300,
        operate_kid: keys.kid,
        operate_public_jwk: keys.publicJwk,
        redirect_paths: paths,
      };
      const payload_hash = await orgPayloadDigest(manifest);
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer: auth.data.session.accessToken,
        statement: orgAppRegisterStatement({ org: args.orgId, payload: payload_hash }),
        displayHint: `Register App ${manifest.host}`,
        openBrowserFlag,
      });
      const proof = await cer.wait();
      const registered = await api.postAppRegister(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId, {
        ...manifest,
        proposer_receipt: proof,
      });
      const operate_private_jwk_path = await saveOperatePrivateJwk(registered.app_id, keys.privateJwkJson);
      return {
        ok: true,
        data: {
          app_id: registered.app_id,
          host: registered.host,
          operate_private_jwk_path,
          human: {
            needs_human: "passkey",
            message:
              "App registered (pending host). Operate key saved locally (0600). Next: app_host_plan.",
          },
        },
      };
    },

    async appHostPlan(orgId, appId) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const ch = await api.getHostChallenge(auth.data.origins.apiOrigin, auth.data.session.accessToken, orgId, appId);
      return {
        ok: true,
        data: {
          host: ch.host,
          txt_record_name: ch.txt_record_name,
          txt_value: ch.txt_value,
          human: {
            needs_human: "dns",
            message: "Publish this TXT on the App host, then call app_verify_host (Passkey).",
          },
        },
      };
    },

    async appVerifyHost(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const ch = await api.getHostChallenge(
        auth.data.origins.apiOrigin,
        auth.data.session.accessToken,
        args.orgId,
        args.appId,
      );
      const nonceMatch = /nonce=([^;]+)/.exec(ch.txt_value);
      const nonce = nonceMatch?.[1]?.trim() ?? "";
      if (!nonce) return { ok: false, error: "host_challenge_missing_nonce" };
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer: auth.data.session.accessToken,
        statement: orgAppVerifyHostStatement({ org: args.orgId, app: args.appId, host: ch.host, nonce }),
        displayHint: `Verify host ${ch.host}`,
        openBrowserFlag,
      });
      try {
        const proof = await cer.wait();
        const out = await api.postVerifyHost(
          auth.data.origins.apiOrigin,
          auth.data.session.accessToken,
          args.orgId,
          args.appId,
          proof,
        );
        return { ok: true, data: { status: out.status } };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          human: {
            needs_human: "dns",
            message: "Confirm App host TXT is published, complete Passkey, then retry app_verify_host.",
            open_url: cer.ceremony_url,
          },
        };
      }
    },

    async declarationSet(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const declaration = { endUsers: args.endUsers, uses: args.uses };
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer: auth.data.session.accessToken,
        statement: await orgAppDeclarationStatement({ org: args.orgId, app: args.appId, declaration }),
        displayHint: `Declare uses for App ${args.appId}`,
        openBrowserFlag,
      });
      const proof = await cer.wait();
      const out = await api.putDeclaration(
        auth.data.origins.apiOrigin,
        auth.data.session.accessToken,
        args.orgId,
        args.appId,
        { endUsers: args.endUsers, uses: args.uses, receipt: proof },
      );
      return { ok: true, data: { declaration: out.declaration } };
    },

    async appRegionsSet(args) {
      const read = readAppRegionsInput(args.regions);
      if (!read.ok) return read;
      const regions = read.regions;
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const sub = auth.data.session.sub;
      if (!sub) return { ok: false, error: "session_missing_sub — re-login" };
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      const app = await api.getApp(apiOrigin, bearer, args.orgId, args.appId);
      if (app.status === "disabled") return appDisabledRefusal();
      if (sameAppRegions(app.accepted_regions, regions)) {
        return { ok: true, data: { accepted_regions: regions, unchanged: true } };
      }
      if (regions) {
        // A region Clavis does not accept right now is refused before the passkey; when the list cannot be read, the API's own check decides.
        const selectable = await api.getSelectableAppRegions(apiOrigin).catch(() => null);
        const closed = selectable ? regions.filter((region) => !selectable.includes(region)) : [];
        if (closed.length > 0) return regionNotOpenRefusal(closed, selectable);
      }
      const cer = await runPasskeyCeremony({
        origins: auth.data.origins,
        bearer,
        statement: orgAppRegionsStatement({ org: args.orgId, app: args.appId, regions }),
        displayHint: regions
          ? `Accept new connections to ${app.host} from ${regions.join(", ")} only`
          : `Accept new connections to ${app.host} from every region Clavis accepts`,
        openBrowserFlag,
      });
      const proof = await cer.wait();
      try {
        await api.putAppRegions(apiOrigin, bearer, args.orgId, args.appId, { regions, receipt: proof });
        return { ok: true, data: { accepted_regions: regions } };
      } catch (e) {
        const refusal = appRegionsRefusal(e, regions ?? []);
        if (refusal) return refusal;
        throw e;
      }
    },

    async appLexDocument(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        return { ok: true, data: await api.postAppLexDocument(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId, args.appId, args.url) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async appLexProfileSet(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      try {
        const prepared = await api.postAppLexProfileStatement(apiOrigin, bearer, args.orgId, args.appId, args.profile);
        const cer = await runPasskeyCeremony({
          origins: auth.data.origins,
          bearer,
          statement: prepared.statement as Statement,
          displayHint: args.profile === null ? "Clear the App's agreement profile" : "Set the App's agreement profile",
          openBrowserFlag,
        });
        const proof = await cer.wait();
        return { ok: true, data: await api.putAppLexProfile(apiOrigin, bearer, args.orgId, args.appId, { profile: args.profile, receipt: proof }) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexCounts(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        return { ok: true, data: await api.postLexDecisionCounts(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId, args.query ?? {}) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexExport(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      try {
        const prepared = await api.postLexExportStatement(apiOrigin, bearer, args.orgId, args.request);
        let receipt: Receipt | undefined;
        if (prepared.statement) {
          const cer = await runPasskeyCeremony({
            origins: auth.data.origins,
            bearer,
            statement: prepared.statement as Statement,
            displayHint: "Export the organisation's agreement records",
            openBrowserFlag,
          });
          receipt = await cer.wait();
        }
        return { ok: true, data: await api.postLexExport(apiOrigin, bearer, args.orgId, { request: args.request, ...(receipt ? { receipt } : {}) }) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexExports(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        return { ok: true, data: await api.getLexExports(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexExportStatus(args) {
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        return { ok: true, data: await api.getLexExport(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId, args.jobId) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexExportDownload(args) {
      if (!/^[0-9a-f]{32}$/.test(args.jobId)) return { ok: false, error: "job_id_invalid" };
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      try {
        const { job } = await api.getLexExport(apiOrigin, bearer, args.orgId, args.jobId);
        if (job.state !== "done" || typeof job.manifest_digest !== "string") {
          return { ok: false, error: `export_not_done — the export is ${String(job.state)}. Check again with lex-export-status.` };
        }
        const manifestBytes = await api.getLexExportFile(apiOrigin, bearer, args.orgId, args.jobId, "manifest.json");
        if ((await bytesDigest(manifestBytes)) !== job.manifest_digest) {
          return { ok: false, error: "export_manifest_mismatch — the manifest does not hash to the digest Clavis anchored. Nothing was kept." };
        }
        const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
        if (manifest?.kind !== "lex.package@1" || manifest.job_id !== args.jobId || !Array.isArray(manifest.files)) {
          return { ok: false, error: "invalid_export_manifest" };
        }
        const files: { path: string; bytes: number }[] = [];
        const seen = new Set(["manifest.json", "anchor.json"]);
        await mkdir(args.dir, { recursive: true, mode: 0o700 });
        const staging = await mkdtemp(join(args.dir, ".clavis-export-"));
        const store = async (path: string, bytes: Uint8Array) => {
          await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
          await writeFile(join(staging, path), bytes, { flag: "wx", mode: 0o600 });
          files.push({ path, bytes: bytes.byteLength });
        };
        try {
          await store("manifest.json", manifestBytes);
          for (const entry of manifest.files) {
            if (typeof entry?.path !== "string" || !LEX_EXPORT_PATH.test(entry.path) || seen.has(entry.path)) {
              return { ok: false, error: "invalid_export_manifest" };
            }
            seen.add(entry.path);
            const bytes = await api.getLexExportFile(apiOrigin, bearer, args.orgId, args.jobId, entry.path);
            if (bytes.byteLength !== entry.bytes || (await bytesDigest(bytes)) !== entry.sha256) {
              return { ok: false, error: `export_file_mismatch — ${entry.path} differs from the manifest.` };
            }
            await store(entry.path, bytes);
          }
          await store("anchor.json", await api.getLexExportFile(apiOrigin, bearer, args.orgId, args.jobId, "anchor.json"));
          const root = join(args.dir, args.jobId);
          await rename(staging, root);
          return { ok: true, data: { dir: root, manifest_digest: job.manifest_digest, files } };
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexDecision(args) {
      if (!LEX_DECISION_ID.test(args.decisionId)) return { ok: false, error: "decision_id_invalid — pass the decision_id Clavis returned for the agreement." };
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        return { ok: true, data: await api.getLexDecision(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId, args.decisionId) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexSubjectDecisions(args) {
      if (!LEX_SUBJECT.test(args.subject)) return { ok: false, error: "subject_invalid — pass the person's ID in your App (the sub you passed as allowedSub)." };
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      try {
        return { ok: true, data: await api.getLexSubjectDecisions(auth.data.origins.apiOrigin, auth.data.session.accessToken, args.orgId, args.subject) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async lexSubjectErase(args) {
      if (!LEX_SUBJECT.test(args.subject)) return { ok: false, error: "subject_invalid — pass the person's ID in your App (the sub you passed as allowedSub)." };
      const auth = await requireSession(sessionPath);
      if (!auth.ok) return auth;
      const apiOrigin = auth.data.origins.apiOrigin;
      const bearer = auth.data.session.accessToken;
      try {
        const cer = await runPasskeyCeremony({
          origins: auth.data.origins,
          bearer,
          statement: orgLexSubjectEraseStatement({ org: args.orgId, subject: args.subject }),
          displayHint: "Erase one person's agreement records",
          openBrowserFlag,
        });
        const proof = await cer.wait();
        return { ok: true, data: await api.postLexSubjectErase(apiOrigin, bearer, args.orgId, args.subject, proof) };
      } catch (e) {
        const refusal = lexRefusal(e);
        if (refusal) return refusal;
        throw e;
      }
    },

    async emitEnv(args) {
      const jwk =
        args.operatePrivateJwkJson?.trim() || (await readOperatePrivateJwk(args.appId)) || "";
      if (!jwk) {
        return {
          ok: false,
          error: "operate_jwk_missing",
          human: {
            needs_human: "login",
            message: "Run app-register first so the operate key exists under ~/.config/clavis/apps/",
          },
        };
      }
      const out = await emitAppEnv({
        origins,
        appId: args.appId,
        operatePrivateJwkJson: jwk,
      });
      return { ok: true, data: out };
    },
  };

  return client;
}

export type { StoredSetupSession };
export { loadSession, originsFromEnv };
