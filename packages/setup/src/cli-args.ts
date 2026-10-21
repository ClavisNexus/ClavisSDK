import { chooseAppRegions } from "./app-regions.js";
import type { CardCheckoutOptions } from "./card.js";
import type { OrgCreationTerms } from "./org-creation.js";

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

/** A flag that takes no value. True only when it was passed in exactly that spelling. */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** The arguments left after the flags and the values of valueFlags are removed. */
export function positionals(args: string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

/** Agreement to the Customer Terms is recorded only with --accept-customer-terms. It is never on by default. */
export function orgCreationTermsFromArgs(args: string[]): OrgCreationTerms {
  return {
    incorporation: flag(args, "--incorporation"),
    acceptCustomerTerms: hasFlag(args, "--accept-customer-terms"),
  };
}

/** Consent to provide billing data is recorded only with --consent-billing-data. It is never on by default. */
export function cardCheckoutOptionsFromArgs(
  args: string[],
): { ok: true; options: CardCheckoutOptions } | { ok: false; error: string } {
  const offer = flag(args, "--offer");
  if (offer !== undefined && offer !== "meter" && offer !== "bundle") {
    return { ok: false, error: "--offer must be meter or bundle" };
  }
  const lang = flag(args, "--lang");
  if (lang !== undefined && lang !== "en" && lang !== "ja") {
    return { ok: false, error: "--lang must be en or ja" };
  }
  return {
    ok: true,
    options: {
      ...(offer ? { offer } : {}),
      ...(lang ? { lang } : {}),
      consentBillingData: hasFlag(args, "--consent-billing-data"),
    },
  };
}

/** One of `--regions JP,US` or `--all`, not both. `--all` is every region Clavis accepts, which is null. */
export function appRegionsFromArgs(
  args: string[],
): { ok: true; regions: readonly string[] | null } | { ok: false; error: string } {
  const raw = flag(args, "--regions");
  const listed = args.includes("--regions");
  return chooseAppRegions({
    ...(listed ? { regions: (raw ?? "").split(",").filter((code) => code.trim().length > 0) } : {}),
    all: hasFlag(args, "--all"),
  });
}
