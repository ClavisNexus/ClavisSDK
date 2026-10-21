import { SetupApiError } from "./org-api.js";
import { incorporationInvalidRefusal } from "./org-creation.js";
import { LEGAL_ORIGIN, type HumanAction, type OrgCardView } from "./types.js";

/** What to pass to checkout for the signature card. */
export type CardCheckoutOptions = {
  /** `meter`, which is metered and the default, or `bundle`, the monthly bundle. */
  offer?: "meter" | "bundle";
  /**
   * Set this true only once the customer has consented to their billing data going to the payment
   * provider in the United States, for payment and billing. Whether to consent is the customer's
   * decision, and the SDK never sets it true by default.
   */
  consentBillingData?: boolean;
  /** The language the consent statement is shown in, `en` or `ja`, defaulting to `en`. The purchase record is tied to the statement in that language. */
  lang?: "en" | "ja";
};

type Refusal = { ok: false; error: string; human?: HumanAction };

export function checkoutLang(raw: unknown): "en" | "ja" {
  return raw === "ja" ? "ja" : "en";
}

/** The same consent statement as the card screen on developers. */
const BILLING_CONSENT = {
  en: {
    lead: "Subscribing needs the customer's own consent. Show them the statement below and ask. Do not consent on their behalf.",
    statement:
      "I consent to Clavis providing Polar Software Inc. in the United States with my Clavis account identifier, the organisation ID, the feature being purchased, and, after purchase, the organisation's usage of that feature (counts and times), for payment and billing. Polar handles that data under its own privacy notice.",
    info: (privacyUrl: string) =>
      `Section 5 of the Privacy Notice (${privacyUrl}) sets out the destination country, an outline of the United States regime, and Polar's measures. Without consent you cannot subscribe, and nothing is sent to Polar.`,
    versions: (terms: string, dpa: string) => `This purchase is made under Customer Terms ${terms} and DPA ${dpa}.`,
    next: "If they consent, run again with --consent-billing-data (MCP: consent_billing_data: true).",
  },
  ja: {
    lead: "購入には顧客本人の同意が要ります。次の文を見せて確かめてください。代わりに同意しないでください。",
    statement:
      "決済と請求のため、Clavis アカウント識別子、Org ID と購入する機能、および購入後の利用量（件数と日時）を、米国の Polar Software Inc. に提供することに同意します。Polar は自らのプライバシー通知に従って取り扱います。",
    info: (privacyUrl: string) =>
      `移転先の国、米国の制度の概要、Polar の措置はプライバシー通知の第 5 節（${privacyUrl}）にあります。同意しない場合は購入できず、Polar へは何も送りません。`,
    versions: (terms: string, dpa: string) => `この購入は、組織の契約 ${terms} と DPA ${dpa} のもとで行います。`,
    next: "同意を得たら、--consent-billing-data（MCP: consent_billing_data: true）を付けてもう一度実行します。",
  },
} as const;

export function billingConsentHuman(acceptance: OrgCardView["acceptance"], lang: "en" | "ja"): HumanAction {
  const copy = BILLING_CONSENT[lang];
  return {
    needs_human: "terms",
    message: [
      copy.lead,
      copy.statement,
      copy.info(`${LEGAL_ORIGIN}/${lang}/privacy`),
      copy.versions(acceptance.customer_terms_version, acceptance.dpa_version),
      copy.next,
    ].join("\n"),
  };
}

export function incorporationNeededRefusal(orgId: string, stale: boolean): Refusal {
  const why = stale
    ? "The Customer Terms have a newer version, so the place of incorporation must be declared again."
    : "Set the place of incorporation before subscribing.";
  return {
    ok: false,
    error: stale ? "incorporation_stale" : "incorporation_required",
    human: {
      needs_human: "terms",
      message: `${why} Run: clavis incorporation-set ${orgId} --incorporation CODE --accept-customer-terms (MCP: clavis_incorporation_set), after the customer agrees.`,
    },
  };
}

export function purchaseRegionClosedRefusal(incorporation: string): Refusal {
  return {
    ok: false,
    error: `region_closed — new subscriptions are not accepted right now for Orgs incorporated in ${incorporation}.`,
  };
}

export function declarationRegionClosedRefusal(incorporation: string): Refusal {
  return {
    ok: false,
    error: `region_closed — ${incorporation} cannot be declared as the place of incorporation right now. GET /orgs/regions lists the closed places.`,
  };
}

/** Turn the API's reason for refusing a checkout into wording that says what happened. Anything else is null. */
export function checkoutRefusal(e: unknown, args: { orgId: string; incorporation: string }): Refusal | null {
  if (!(e instanceof SetupApiError)) return null;
  switch (e.code) {
    case "REGION_CLOSED":
      return purchaseRegionClosedRefusal(args.incorporation);
    case "INCORPORATION":
      return incorporationNeededRefusal(args.orgId, e.message === "incorporation_stale");
    case "AGE_INELIGIBLE":
      return { ok: false, error: "age_ineligible — an organisation contract can be made by someone who is 18 or older." };
    case "AGE_BAND_REQUIRED":
      return {
        ok: false,
        error: "age_band_required — this account has no age record, so the organisation contract can't continue.",
      };
    case "BILLING_SUBJECT":
      return {
        ok: false,
        error:
          "billing_subject_taken — this account already pays for another Org. Another owner or admin of this Org can subscribe instead.",
      };
    case "CHECKOUT_CLOSED":
      return { ok: false, error: "checkout_closed — the card checkout is not open right now." };
    default:
      return null;
  }
}

/** Turn the API's reason for refusing a place-of-incorporation declaration into wording that says what happened. Anything else is null. */
export function incorporationSetRefusal(e: unknown, incorporation: string): Refusal | null {
  if (!(e instanceof SetupApiError)) return null;
  if (e.code === "REGION_CLOSED") return declarationRegionClosedRefusal(incorporation);
  if (e.code === "INCORPORATION") return incorporationInvalidRefusal(incorporation);
  return null;
}
