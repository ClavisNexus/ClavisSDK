import type { HandoffPhaseId, HandoffText, HandoffTextOverride } from "./types.js";

const EN: HandoffText = {
  title: "Getting ready to sign",
  hint: "Registering the request you will sign.",
  streamTitle: "Progress",
  phases: {
    digest: "Prepare the details",
    register: "Register the request",
  },
  errorTitle: "Preparation stopped",
  errorHint: "Nothing has been signed.",
  errorRetry: "Try again in a moment.",
  errorBlocked: "Please contact this site's support.",
};

const JA: HandoffText = {
  title: "署名の準備",
  hint: "署名する内容を登録しています。",
  streamTitle: "進行状況",
  phases: {
    digest: "内容を準備",
    register: "署名依頼を登録",
  },
  errorTitle: "準備を中断しました",
  errorHint: "署名はまだ行われていません。",
  errorRetry: "もう一度お試しください。",
  errorBlocked: "このサイトのサポートにお問い合わせください。",
};

function freeze(text: HandoffText): HandoffText {
  Object.freeze(text.phases);
  return Object.freeze(text);
}

/** The languages this package ships. Pass `text` to openHandoffShell for any other language. */
export const HANDOFF_TEXT = Object.freeze({ en: freeze(EN), ja: freeze(JA) });

export type HandoffLocale = keyof typeof HANDOFF_TEXT;

const FALLBACK_LOCALE: HandoffLocale = "en";

function primarySubtag(tag: string): string {
  return tag.trim().replace(/_/g, "-").split("-", 1)[0]?.toLowerCase() ?? "";
}

function match(tags: readonly string[]): HandoffLocale | undefined {
  for (const tag of tags) {
    const base = primarySubtag(tag);
    if (base in HANDOFF_TEXT) return base as HandoffLocale;
  }
  return undefined;
}

function browserLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Pick the overlay's language: `uiLocales` in order, then the browser's languages, then `en`.
 * `override` replaces single keys, so a language this package does not ship can be passed in whole.
 */
export function resolveHandoffText(
  uiLocales?: readonly string[],
  override?: HandoffTextOverride,
): HandoffText {
  const locale = match(uiLocales ?? []) ?? match(browserLocales()) ?? FALLBACK_LOCALE;
  const base = HANDOFF_TEXT[locale];
  if (!override) return base;
  const { phases, ...rest } = override;
  const merged: HandoffText = { ...base, phases: { ...base.phases } };
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === "string") merged[key as keyof typeof rest] = value;
  }
  for (const [id, label] of Object.entries(phases ?? {})) {
    if (typeof label === "string") merged.phases[id as HandoffPhaseId] = label;
  }
  return merged;
}
