import type { HandoffPhaseId, HandoffText, HandoffTextOverride } from "./types.js";

const EN: HandoffText = {
  title: "Getting ready to sign",
  hint: "Registering the request Connect will ask you to approve.",
  streamTitle: "Progress",
  phases: {
    digest: "Prepare the details",
    register: "Register the request",
    connect: "Hand over to Connect",
  },
  errorTitle: "Couldn't reach Connect",
  errorHint: "Nothing has been signed.",
  errorRetry: "Try again in a moment.",
  errorBlocked: "Please contact this site's support.",
};

const JA: HandoffText = {
  title: "署名の準備",
  hint: "Connect へ渡す操作内容を登録しています。",
  streamTitle: "進行状況",
  phases: {
    digest: "内容を準備",
    register: "署名依頼を登録",
    connect: "Connect へ",
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

/** The language this package shows: `uiLocales` in order, then the browser's languages, then `en` */
export function resolveLocale(uiLocales?: readonly string[]): HandoffLocale {
  return match(uiLocales ?? []) ?? match(browserLocales()) ?? FALLBACK_LOCALE;
}

/**
 * Pick the overlay's language: `uiLocales` in order, then the browser's languages, then `en`.
 * `override` replaces single keys, so a language this package does not ship can be passed in whole.
 */
export function resolveHandoffText(
  uiLocales?: readonly string[],
  override?: HandoffTextOverride,
): HandoffText {
  const locale = resolveLocale(uiLocales);
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

/** The wording of the Clavis button, written for each language. Keys are shared; the wording is not a translation */
export type ClavisButtonText = {
  /** The label of each kind of button */
  label: { "sign-in": string; link: string };
  /** The line under the button when `start` failed: another press may get through */
  retry: { "sign-in": string; link: string };
  /** The line under the button when the URL from `start` will not be opened: another press will not help */
  blocked: { "sign-in": string; link: string };
};

const BUTTON_EN: ClavisButtonText = {
  label: { "sign-in": "Sign in with Clavis", link: "Link your Clavis account" },
  retry: {
    "sign-in": "Couldn't start signing in. Try again in a moment.",
    link: "Couldn't start linking your account. Try again in a moment.",
  },
  blocked: {
    "sign-in": "Couldn't start signing in. Please contact this site's support.",
    link: "Couldn't start linking your account. Please contact this site's support.",
  },
};

const BUTTON_JA: ClavisButtonText = {
  label: { "sign-in": "Clavis でサインイン", link: "Clavis と連携" },
  retry: {
    "sign-in": "サインインを始められませんでした。もう一度お試しください。",
    link: "連携を始められませんでした。もう一度お試しください。",
  },
  blocked: {
    "sign-in": "サインインを始められませんでした。このサイトのサポートにお問い合わせください。",
    link: "連携を始められませんでした。このサイトのサポートにお問い合わせください。",
  },
};

function freezeButton(text: ClavisButtonText): ClavisButtonText {
  Object.freeze(text.label);
  Object.freeze(text.retry);
  Object.freeze(text.blocked);
  return Object.freeze(text);
}

/** The Clavis button's wording, by language. The button resolves the language the same way as the handoff overlay */
export const CLAVIS_BUTTON_TEXT: Readonly<Record<HandoffLocale, ClavisButtonText>> = Object.freeze({
  en: freezeButton(BUTTON_EN),
  ja: freezeButton(BUTTON_JA),
});
