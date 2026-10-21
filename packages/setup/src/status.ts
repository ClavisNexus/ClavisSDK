import * as api from "./org-api.js";
import type { DevelopersSession, OrgCardView, SetupOrigins, SetupStatusReport } from "./types.js";

type OrgStatus = SetupStatusReport["orgs"][number];

/** `open` means the subscription is live and nothing holds it back but this month's ceiling. */
function signatureCard(card: OrgCardView): Pick<OrgStatus, "signature_card" | "signature_card_blockers"> {
  const sig = card.capabilities?.signature;
  if (!sig) return { signature_card: "inactive" };
  if (sig.open === true) return { signature_card: "active" };
  return {
    signature_card: "inactive",
    ...(Array.isArray(sig.blockers) && sig.blockers.length > 0 ? { signature_card_blockers: sig.blockers } : {}),
  };
}

function incorporationOf(card: OrgCardView): OrgStatus["incorporation"] {
  const inc = card.incorporation;
  return inc ? { code: inc.code, terms_current: inc.terms_current === true } : null;
}

export async function buildSetupStatus(args: {
  origins: SetupOrigins;
  session: DevelopersSession | null;
}): Promise<SetupStatusReport> {
  if (!args.session) {
    return { logged_in: false, orgs: [] };
  }

  const orgs = await api.listOrgs(args.origins.apiOrigin, args.session.accessToken);
  const detailed: SetupStatusReport["orgs"] = [];

  for (const org of orgs) {
    let setup_complete = false;
    let card: Pick<OrgStatus, "signature_card" | "signature_card_blockers" | "incorporation"> = {
      signature_card: "unknown",
    };
    let apps: OrgStatus["apps"] = [];
    try {
      const detail = await api.getOrg(args.origins.apiOrigin, args.session.accessToken, org.org_id);
      setup_complete = detail.setup_complete;
    } catch {
      // keep false
    }
    try {
      const view = await api.getCard(args.origins.apiOrigin, args.session.accessToken, org.org_id);
      card = { ...signatureCard(view), incorporation: incorporationOf(view) };
    } catch {
      card = { signature_card: "unknown" };
    }
    try {
      const list = await api.listApps(args.origins.apiOrigin, args.session.accessToken, org.org_id);
      apps = list.map((a) => ({
        app_id: a.app_id,
        host: a.host,
        status: a.status,
        ...(a.accepted_regions ? { accepted_regions: a.accepted_regions } : {}),
        declaration_ok: Boolean(
          a.declaration &&
            typeof a.declaration.endUsers === "string" &&
            a.declaration.endUsers.trim() &&
            Array.isArray(a.declaration.uses) &&
            a.declaration.uses.some((u) => u.capability === "signature"),
        ),
      }));
      // Enrich declaration from detail when list omits it
      for (let i = 0; i < apps.length; i++) {
        if (apps[i]!.declaration_ok) continue;
        try {
          const full = await api.getApp(
            args.origins.apiOrigin,
            args.session.accessToken,
            org.org_id,
            apps[i]!.app_id,
          );
          apps[i]!.declaration_ok = Boolean(
            full.declaration &&
              typeof full.declaration.endUsers === "string" &&
              full.declaration.endUsers.trim() &&
              Array.isArray(full.declaration.uses) &&
              full.declaration.uses.some((u) => u.capability === "signature"),
          );
          apps[i]!.status = full.status;
        } catch {
          // leave as-is
        }
      }
    } catch {
      apps = [];
    }

    detailed.push({
      org_id: org.org_id,
      name: org.name,
      primary_domain: org.primary_domain,
      org_status: org.org_status,
      setup_complete,
      ...card,
      apps,
    });
  }

  return {
    logged_in: true,
    sub: args.session.sub,
    orgs: detailed,
  };
}
