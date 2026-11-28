import { ClavisButtonError, type ClavisButtonErrorCode } from "./errors.js";
import { MARK_PATHS, MARK_VIEWBOX } from "./mark.generated.js";
import { checkNavigationUrl, type NavigationRefusal } from "./navigation.js";
import { CLAVIS_BUTTON_TEXT, CLAVIS_LINK_BUTTON_TEXT, resolveLocale, type ClavisButtonText, type HandoffLocale } from "./text.js";

/** `primary` is an ink fill; `secondary` is the sheet with an ink rule */
export type ClavisButtonTone = "primary" | "secondary";
/** `auto` follows `prefers-color-scheme` */
export type ClavisButtonTheme = "light" | "dark" | "auto";
/** `content` is as wide as the label; `fluid` fills the column it is placed in */
export type ClavisButtonWidth = "content" | "fluid";

/** The action started by the button. Omit it for sign-in. */
export type ClavisButtonKind = "sign-in" | "link";

/** What the business chooses. Colour, shape, corners, type, wording, mark and height are fixed */
export type ClavisButtonOptions = {
  tone: ClavisButtonTone;
  kind?: ClavisButtonKind;
  /** Default `auto` */
  theme?: ClavisButtonTheme;
  /** Default `content` */
  width?: ClavisButtonWidth;
  /**
   * BCP 47 language tags, in order of preference. The package ships `ja` and `en`. Omitted, or none
   * shipped, it follows the browser's languages, then `en`. Pass the same list you give the server.
   */
  uiLocales?: readonly string[];
};

export type MountClavisButtonOptions = ClavisButtonOptions & {
  /**
   * Hostnames the button may navigate to (the API host, e.g. `api.clavis.nexus`). The button opens
   * only an https URL on this list; http is accepted only on a loopback host.
   */
  allowedHosts: readonly string[];
  /**
   * Called when the button is pressed, and not before. Call your own server and return the URL to
   * open: the authorization URL from `beginSignIn` or the `consumeUrl` from `registerLink`.
   */
  start: () => Promise<string>;
  /** Defaults to `window.location.assign` */
  assign?: (url: string) => void;
  /** Receives the error of a press that failed (the button already shows its line) */
  onError?: (error: Error) => void;
};

export type ClavisButtonHandle = {
  button: HTMLButtonElement;
  /** Press the button from code. Rejects as a press would fail: with what `start` or `assign` threw, or a `ClavisButtonError` */
  press: () => Promise<void>;
  /** Remove the button and its listeners */
  unmount: () => void;
};

type Node = { tag: string; svg?: boolean; attrs: Array<[string, string]>; children: Array<Node | string> };

const TONES: readonly ClavisButtonTone[] = ["primary", "secondary"];
const THEMES: readonly ClavisButtonTheme[] = ["light", "dark", "auto"];
const WIDTHS: readonly ClavisButtonWidth[] = ["content", "fluid"];

function pick<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T | undefined, name: string): T {
  const v = value ?? fallback;
  if (v === undefined || !allowed.includes(v)) throw new TypeError(`${name} must be one of ${allowed.join(", ")}`);
  return v;
}

type Resolved = { tone: ClavisButtonTone; theme: ClavisButtonTheme; width: ClavisButtonWidth; locale: HandoffLocale; text: ClavisButtonText };

function resolve(options: ClavisButtonOptions): Resolved {
  if (!options || typeof options !== "object") throw new TypeError("options required");
  const locale = resolveLocale(options.uiLocales);
  const kind = pick(options.kind, ["sign-in", "link"], "sign-in", "kind");
  return {
    tone: pick(options.tone, TONES, undefined, "tone"),
    theme: pick(options.theme, THEMES, "auto", "theme"),
    width: pick(options.width, WIDTHS, "content", "width"),
    locale,
    text: (kind === "link" ? CLAVIS_LINK_BUTTON_TEXT : CLAVIS_BUTTON_TEXT)[locale],
  };
}

/** The button, the mark and the line under it, as one description both renderers read */
function tree(r: Resolved): Node {
  const mark: Node = {
    tag: "svg",
    svg: true,
    attrs: [
      ["class", "clavis-button-mark"],
      ["viewBox", MARK_VIEWBOX],
      ["aria-hidden", "true"],
    ],
    children: MARK_PATHS.map((p) => ({
      tag: "path",
      svg: true,
      attrs: [
        ["d", p.d],
        ["pathLength", "1"],
        ["stroke-width", String(p.width)],
        ["data-kind", p.kind],
        ["data-i", String(p.index)],
      ],
      children: [],
    })),
  };
  return {
    tag: "span",
    attrs: [
      ["class", "clavis-button-root"],
      ["data-theme", r.theme],
      ["data-width", r.width],
      ["lang", r.locale],
    ],
    children: [
      {
        tag: "button",
        attrs: [
          ["type", "button"],
          ["class", "clavis-button"],
          ["data-tone", r.tone],
        ],
        children: [mark, { tag: "span", attrs: [["class", "clavis-button-label"]], children: [r.text.label] }],
      },
      { tag: "span", attrs: [["class", "clavis-button-note"], ["role", "status"]], children: [] },
    ],
  };
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

function toHtml(node: Node | string): string {
  if (typeof node === "string") return escapeText(node);
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  return `<${node.tag}${attrs}>${node.children.map(toHtml).join("")}</${node.tag}>`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function toDom(node: Node | string, doc: Document): globalThis.Node {
  if (typeof node === "string") return doc.createTextNode(node);
  const el = node.svg ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
  for (const [k, v] of node.attrs) el.setAttribute(k, v);
  for (const child of node.children) el.appendChild(toDom(child, doc));
  return el;
}

/**
 * The button as an HTML string, for a page rendered on the server. It carries no script, no image and
 * no address: nothing is fetched until it is pressed, and pressing does nothing until
 * `mountClavisButton` attaches the behaviour.
 */
export function renderClavisButtonHtml(options: ClavisButtonOptions): string {
  return toHtml(tree(resolve(options)));
}

const START_URL_REFUSALS: Record<NavigationRefusal, [ClavisButtonErrorCode, (host?: string) => string]> = {
  invalid: ["invalid_start_url", () => "the URL start returned is not an absolute URL"],
  insecure: ["insecure_start_url", () => "the URL start returned must be https; http is accepted only on a loopback host"],
  credentials: ["start_url_credentials", () => "the URL start returned must not carry credentials"],
  host_not_allowed: ["start_url_host_not_allowed", (host) => `the URL start returned is on ${host}, which is not in allowedHosts`],
};

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Put the sign-in or link button in `element` (its content is replaced, so markup from
 * `renderClavisButtonHtml` can stand there until this runs). Nothing is sent before the button is
 * pressed; no cookie is set and nothing is measured.
 *
 * On a press the button waits in place and calls `start`. It navigates only to an https URL on
 * `allowedHosts`. When `start` fails, or the URL will not be opened, a line in the viewer's language
 * appears under the button, without the technical reason; `press()` rejects with it and `onError`
 * receives it.
 */
export function mountClavisButton(element: HTMLElement, options: MountClavisButtonOptions): ClavisButtonHandle {
  if (!element || typeof element.replaceChildren !== "function") throw new TypeError("element must be an HTML element");
  const r = resolve(options);
  if (typeof options.start !== "function") throw new TypeError("start must be a function returning the URL to open");
  if (!Array.isArray(options.allowedHosts)) throw new TypeError("allowedHosts must list the hosts the button may open");
  const doc = element.ownerDocument;
  const root = toDom(tree(r), doc) as HTMLElement;
  const button = root.querySelector("button") as HTMLButtonElement;
  const note = root.querySelector(".clavis-button-note") as HTMLElement;
  const assign = options.assign ?? ((url: string) => doc.defaultView!.location.assign(url));
  let inflight: Promise<void> | null = null;

  function waiting(on: boolean): void {
    if (on) {
      button.setAttribute("aria-busy", "true");
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("aria-busy");
      button.removeAttribute("aria-disabled");
    }
  }

  /** Back to the button the viewer can press, with the line for why it stopped */
  function stop(line: string, error: Error): never {
    waiting(false);
    note.textContent = line;
    throw error;
  }

  async function run(): Promise<void> {
    let returned: string;
    try {
      returned = await options.start();
    } catch (e) {
      stop(r.text.retry, asError(e));
    }
    const checked = checkNavigationUrl(returned, options.allowedHosts);
    if (!checked.ok) {
      const [code, message] = START_URL_REFUSALS[checked.refusal];
      stop(r.text.blocked, new ClavisButtonError(code, message(checked.host), { host: checked.host, cause: checked.cause }));
    }
    try {
      assign(checked.url);
    } catch (e) {
      stop(r.text.blocked, asError(e));
    }
    // The button keeps waiting until the page goes; a page restored from the back-forward cache resets it
  }

  function press(): Promise<void> {
    if (inflight) return inflight;
    note.textContent = "";
    waiting(true);
    const attempt = run();
    inflight = attempt;
    // A failed press frees the button for the next one; a press that navigated keeps it waiting
    attempt.catch(() => {
      if (inflight === attempt) inflight = null;
    });
    return attempt;
  }

  const onClick = () => {
    if (inflight) return;
    press().catch((e: unknown) => options.onError?.(asError(e)));
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    waiting(false);
    inflight = null;
  };
  button.addEventListener("click", onClick);
  doc.defaultView?.addEventListener("pageshow", onPageShow);
  element.replaceChildren(root);

  return {
    button,
    press,
    unmount() {
      button.removeEventListener("click", onClick);
      doc.defaultView?.removeEventListener("pageshow", onPageShow);
      if (root.parentNode === element) element.removeChild(root);
    },
  };
}
