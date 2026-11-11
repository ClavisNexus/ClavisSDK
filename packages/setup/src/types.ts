/**
 * Steps that require a human (browser or infrastructure).
 * `terms` is an agreement only the customer can give: the Customer Terms, or the provision of billing data for a card checkout.
 */
export type NeedsHuman = "passkey" | "payment" | "dns" | "login" | "terms";

export type SetupOrigins = {
  apiOrigin: string;
  idOrigin: string;
  developersOrigin: string;
};

export type DevelopersSession = {
  accessToken: string;
  sub?: string;
  expiresAt?: number;
};

/**
 * A holder receipt (`receipt@2`). Carry it as the JSON string that arrived and pass it on to the Org API.
 * `@clavis.nexus/collatio` 1.0.1, used by `createVerifier` in `@clavis.nexus/app`, refuses this string with `receipt_type`.
 */
export type Receipt = string;

export type HumanAction = {
  needs_human: NeedsHuman;
  message: string;
  open_url?: string;
};

export type SetupResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; human?: HumanAction };

export type OrgSummary = {
  org_id: string;
  name: string;
  role: string;
  primary_domain: string;
  org_status: string;
  capabilities: string[];
};

export type OrgDetail = OrgSummary & {
  setup_complete: boolean;
  governance_mode: string;
  primary_domain: string;
};

export type OrgAppSummary = {
  app_id: string;
  org_id: string;
  host: string;
  display_name: string;
  status: "draft" | "pending_host" | "active" | "disabled";
  intent_types: string[];
  declaration?: { endUsers: string; uses: { capability: string; operation: string }[] } | null;
  /** The regions new connections are accepted from. Absent, it is every region Clavis accepts. */
  accepted_regions?: string[];
};

export type DnsChallenge = {
  domain: string;
  kind: string;
  nonce: string;
  exp: number;
  /** For an anchor only: the statement signed into the published manifest's `receipt` (`org.anchor.publish@1`) */
  statement?: { type: string; [field: string]: unknown };
  well_known_url: string;
  txt_host: string;
};

/** The state of one capability on the card. `open` means the subscription is live and nothing holds it back but the ceiling. */
export type OrgCardCapabilityView = {
  open: boolean;
  register: boolean;
  /** `passkey` | `subscription` | `payment_failed` | `period_ended` | `ceiling` */
  blockers: string[];
  checkout_open?: boolean;
  bundle_checkout_open?: boolean;
  tariff?: "meter" | "bundle" | null;
  [key: string]: unknown;
};

/** The place of incorporation declared. `terms_current` says whether the declaration binds the current Customer Terms and DPA versions. */
export type OrgCardIncorporation = {
  code: string;
  at: number;
  customer_terms_version: string;
  dpa_version: string;
  terms_current: boolean;
};

export type OrgCardView = {
  billing_sub: string;
  month: string;
  suspended: boolean;
  capabilities: Record<string, OrgCardCapabilityView>;
  incorporation: OrgCardIncorporation | null;
  /** The current Customer Terms and DPA versions, which the next declaration and purchase will bind. */
  acceptance: { customer_terms_version: string; dpa_version: string };
};

export type SetupStatusReport = {
  logged_in: boolean;
  sub?: string;
  orgs: Array<{
    org_id: string;
    name: string;
    primary_domain: string;
    org_status: string;
    setup_complete: boolean;
    signature_card: "unknown" | "active" | "inactive";
    /** What holds the signature card back, when `signature_card` is `inactive`. */
    signature_card_blockers?: string[];
    /** The place of incorporation. Null means none is declared. It is left out when the card could not be read. */
    incorporation?: { code: string; terms_current: boolean } | null;
    apps: Array<{
      app_id: string;
      host: string;
      status: string;
      declaration_ok: boolean;
      /** The regions new connections are accepted from. Left out, it is every region Clavis accepts. */
      accepted_regions?: string[];
    }>;
  }>;
};

export const DEFAULT_ORIGINS: SetupOrigins = {
  apiOrigin: "https://api.clavis.nexus",
  idOrigin: "https://id.clavis.nexus",
  developersOrigin: "https://developers.clavis.nexus",
};

/** The host that carries the Customer Terms, the DPA and the Privacy Notice. It appears in the wording that asks for agreement. */
export const LEGAL_ORIGIN = "https://legal.clavis.nexus";
