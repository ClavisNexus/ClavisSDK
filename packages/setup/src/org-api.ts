import type {
  DnsChallenge,
  OrgAppSummary,
  OrgCardView,
  OrgDetail,
  OrgSummary,
  Receipt,
} from "./types.js";

export class SetupApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SetupApiError";
    this.status = status;
    this.code = code;
  }
}

type ApiEnvelope<T> = T & { error?: string; message?: string; payload?: unknown };

async function apiJson<T>(
  apiOrigin: string,
  path: string,
  opts: { method?: string; bearer?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${apiOrigin.replace(/\/+$/, "")}${path}`, {
    method: opts.method ?? "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(opts.bearer !== undefined ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error : `HTTP_${res.status}`;
    const message = typeof body?.message === "string" ? body.message : code;
    throw new SetupApiError(res.status, code, message);
  }
  return (body ?? {}) as T;
}

export async function listOrgs(apiOrigin: string, bearer: string): Promise<OrgSummary[]> {
  const r = await apiJson<{ orgs: OrgSummary[] }>(apiOrigin, "/orgs", { bearer });
  return r.orgs ?? [];
}

export async function getOrg(apiOrigin: string, bearer: string, orgId: string): Promise<OrgDetail> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}`, { bearer });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === "string") : [];
}

/** GET /orgs/regions. It needs no authentication. */
async function getOrgRegions(apiOrigin: string): Promise<{ closed_incorporations?: unknown; app_regions?: unknown }> {
  const r = await apiJson<{ payload?: { closed_incorporations?: unknown; app_regions?: unknown } }>(
    apiOrigin,
    "/orgs/regions",
    {},
  );
  return r.payload ?? {};
}

/** The codes for places of incorporation that are closed to new declarations right now. */
export async function getClosedIncorporations(apiOrigin: string): Promise<string[]> {
  return stringList((await getOrgRegions(apiOrigin)).closed_incorporations);
}

/** The regions an app can choose to accept right now. */
export async function getSelectableAppRegions(apiOrigin: string): Promise<string[]> {
  return stringList((await getOrgRegions(apiOrigin)).app_regions);
}

/** Given an incorporation, the API checks the region before it starts on DNS; a closed one is 403 REGION_CLOSED. */
export async function postDnsChallenge(
  apiOrigin: string,
  bearer: string,
  args: { domain: string; kind?: "anchor" | "approval"; incorporation?: string },
): Promise<DnsChallenge> {
  return apiJson(apiOrigin, "/orgs/dns/challenge", {
    method: "POST",
    bearer,
    body: {
      domain: args.domain.trim(),
      kind: args.kind ?? "anchor",
      ...(args.incorporation !== undefined ? { incorporation: args.incorporation } : {}),
    },
  });
}

/** accept_customer_terms is the customer's agreement. It is sent as true only when the caller passed true. */
export async function postVerifyAnchor(
  apiOrigin: string,
  bearer: string,
  args: { domain: string; nonce: string; name?: string; incorporation?: string; acceptCustomerTerms?: boolean },
): Promise<{ org_id: string; primary_domain: string; org_status: string }> {
  return apiJson(apiOrigin, "/orgs/dns/verify-anchor", {
    method: "POST",
    bearer,
    body: {
      domain: args.domain.trim(),
      nonce: args.nonce,
      ...(args.name ? { name: args.name.trim() } : {}),
      accept_customer_terms: args.acceptCustomerTerms === true,
      ...(args.incorporation !== undefined ? { incorporation: args.incorporation } : {}),
    },
  });
}

export async function postPolicyBootstrap(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  receipt?: Receipt,
): Promise<{ policy_revision_hash: string; already_active: boolean }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/policy/bootstrap`, {
    method: "POST",
    bearer,
    body: receipt ? { receipt } : {},
  });
}

export async function listApps(apiOrigin: string, bearer: string, orgId: string): Promise<OrgAppSummary[]> {
  const r = await apiJson<{ apps: OrgAppSummary[] }>(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps`, {
    bearer,
  });
  return r.apps ?? [];
}

export async function getApp(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
): Promise<OrgAppSummary> {
  const r = await apiJson<{ app: OrgAppSummary }>(
    apiOrigin,
    `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}`,
    { bearer },
  );
  return r.app;
}

export async function postAppRegister(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<{ app_id: string; host: string; status: string }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps`, {
    method: "POST",
    bearer,
    body: payload,
  });
}

export async function getHostChallenge(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
): Promise<{ host: string; txt_record_name: string; txt_value: string; expires_at: number }> {
  return apiJson(
    apiOrigin,
    `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/host-challenge`,
    { bearer },
  );
}

export async function postVerifyHost(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
  receipt: Receipt,
): Promise<{ status: string }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/verify-host`, {
    method: "POST",
    bearer,
    body: { receipt },
  });
}

export async function putDeclaration(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
  args: {
    endUsers: string;
    uses: { capability: string; operation: string }[];
    receipt: Receipt;
  },
): Promise<{ declaration: OrgAppSummary["declaration"] }> {
  return apiJson(
    apiOrigin,
    `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/declaration`,
    {
      method: "PUT",
      bearer,
      body: {
        endUsers: args.endUsers,
        uses: args.uses,
        receipt: args.receipt,
      },
    },
  );
}

/** PUT /orgs/:org/apps/:app/regions — save the regions the app accepts, with a receipt for `org.app.regions@1`. Null removes the list. */
export async function putAppRegions(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
  args: { regions: readonly string[] | null; receipt: Receipt },
): Promise<{ app_id: string; accepted_regions: string[] | null }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/regions`, {
    method: "PUT",
    bearer,
    body: { accepted_regions: args.regions, receipt: args.receipt },
  });
}

export async function getCard(apiOrigin: string, bearer: string, orgId: string): Promise<OrgCardView> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/card`, { bearer });
}

/** POST /orgs/:org/card/incorporation — declare the place of incorporation, with a receipt for `org.card.incorporation_set@1`. */
export async function postCardIncorporation(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  args: { code: string; receipt: Receipt },
): Promise<{ ok: true; incorporation: OrgCardView["incorporation"] }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/card/incorporation`, {
    method: "POST",
    bearer,
    body: { code: args.code, receipt: args.receipt },
  });
}

/**
 * POST /orgs/:org/card/checkout — start checkout for the card, with a receipt for
 * `org.card.checkout@1`. consentBillingData says the customer consented to their billing data being
 * provided. The caller passes true only after confirming that with them.
 */
export async function postCardCheckout(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  args: {
    capability: string;
    offer: "meter" | "bundle";
    consentBillingData: true;
    /** The language the consent was shown in. */
    uiLocale: string;
    receipt: Receipt;
  },
): Promise<{ url: string; checkout_id?: string }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/card/checkout`, {
    method: "POST",
    bearer,
    body: {
      capability: args.capability,
      offer: args.offer,
      consent: { polar_provision: args.consentBillingData },
      ui_locale: args.uiLocale,
      receipt: args.receipt,
    },
  });
}

/**
 * Have the verifier check that the trust surface's documents, the aggregate JWKS and the catalog,
 * chain to the Master public JWK given, and return that JWK as JSON: the value to put in the app's
 * `trustRoot`.
 */
export async function checkTrustRoot(apiOrigin: string, trustRootJson: string): Promise<string> {
  const { createVerifier } = await import("@clavis.nexus/app");
  await createVerifier({ trustRoot: trustRootJson, apiOrigin }).trust();
  return JSON.stringify(JSON.parse(trustRootJson));
}

/** POST /orgs/:org/apps/:app/lex-documents — Clavis takes a snapshot of the org's terms or privacy notice. */
export async function postAppLexDocument(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
  url: string,
): Promise<Record<string, unknown>> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/lex-documents`, {
    method: "POST",
    bearer,
    body: { url },
  });
}

/** POST /orgs/:org/apps/:app/lex-profile/statement — the statement setting this profile signs, and the profile as stored. */
export async function postAppLexProfileStatement(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
  profile: unknown,
): Promise<{ statement: Record<string, unknown> & { type: string }; profile: unknown }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/lex-profile/statement`, {
    method: "POST",
    bearer,
    body: { profile },
  });
}

export async function putAppLexProfile(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  appId: string,
  args: { profile: unknown; receipt: Receipt },
): Promise<{ app_id: string; lex_profile: unknown }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/apps/${encodeURIComponent(appId)}/lex-profile`, {
    method: "PUT",
    bearer,
    body: { profile: args.profile, receipt: args.receipt },
  });
}

/** POST /orgs/:org/lex/decisions/counts — how many agreement decisions a query matches. */
export async function postLexDecisionCounts(apiOrigin: string, bearer: string, orgId: string, query: unknown): Promise<Record<string, unknown>> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/decisions/counts`, { method: "POST", bearer, body: { query } });
}

/** POST /orgs/:org/lex/exports/statement — what starting this export signs (null for one person's export). */
export async function postLexExportStatement(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  request: unknown,
): Promise<{ statement: (Record<string, unknown> & { type: string }) | null; request_digest: string; request: unknown }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/exports/statement`, { method: "POST", bearer, body: { request } });
}

export async function postLexExport(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  args: { request: unknown; receipt?: Receipt },
): Promise<{ job: Record<string, unknown> }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/exports`, {
    method: "POST",
    bearer,
    body: { request: args.request, ...(args.receipt !== undefined ? { receipt: args.receipt } : {}) },
  });
}

export async function getLexExports(apiOrigin: string, bearer: string, orgId: string): Promise<{ jobs: unknown[] }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/exports`, { bearer });
}

export async function getLexExport(apiOrigin: string, bearer: string, orgId: string, jobId: string): Promise<{ job: Record<string, unknown>; anchor?: unknown }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/exports/${encodeURIComponent(jobId)}`, { bearer });
}

/** GET /orgs/:org/lex/decisions/:decision_id — one decision with its record, its ledger proof and where it stands now. */
export async function getLexDecision(apiOrigin: string, bearer: string, orgId: string, decisionId: string): Promise<Record<string, unknown>> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/decisions/${encodeURIComponent(decisionId)}`, { bearer });
}

/** GET /orgs/:org/lex/subjects/:subject/decisions — every decision the org holds for one person. */
export async function getLexSubjectDecisions(apiOrigin: string, bearer: string, orgId: string, subject: string): Promise<Record<string, unknown>> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/subjects/${encodeURIComponent(subject)}/decisions`, { bearer });
}

/** POST /orgs/:org/lex/subjects/:subject/erase — the org's instruction to erase one person's decisions, with a passkey. */
export async function postLexSubjectErase(
  apiOrigin: string,
  bearer: string,
  orgId: string,
  subject: string,
  receipt: Receipt,
): Promise<{ erased: number; decision_ids: string[] }> {
  return apiJson(apiOrigin, `/orgs/${encodeURIComponent(orgId)}/lex/subjects/${encodeURIComponent(subject)}/erase`, {
    method: "POST",
    bearer,
    body: { receipt },
  });
}

/** One file of a finished export, as the bytes Clavis wrote. */
export async function getLexExportFile(apiOrigin: string, bearer: string, orgId: string, jobId: string, path: string): Promise<Uint8Array> {
  const res = await fetch(
    `${apiOrigin.replace(/\/+$/, "")}/orgs/${encodeURIComponent(orgId)}/lex/exports/${encodeURIComponent(jobId)}/files/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    { redirect: "error", headers: { Authorization: `Bearer ${bearer}` } },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    const code = typeof body?.error === "string" ? body.error : `HTTP_${res.status}`;
    throw new SetupApiError(res.status, code, typeof body?.message === "string" ? body.message : code);
  }
  return new Uint8Array(await res.arrayBuffer());
}
