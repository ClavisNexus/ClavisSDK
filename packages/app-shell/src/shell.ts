import { HandoffShellError, type HandoffShellErrorCode } from "./errors.js";
import { checkNavigationUrl, type NavigationRefusal } from "./navigation.js";
import { resolveHandoffText } from "./text.js";
import {
  HANDOFF_PHASE_IDS,
  type HandoffPhaseId,
  type HandoffText,
  type OpenHandoffShellOptions,
} from "./types.js";

const SPINNER = '<span class="clavis-handoff-spinner" aria-hidden="true"></span>';

const MAX_PHASE_GAP_MS = 420;

const BODY_OPEN = "clavis-handoff-open";

let titleSeq = 0;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function resolveGap(requested: number | undefined): number {
  if (prefersReducedMotion()) return 0;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.max(0, Math.min(MAX_PHASE_GAP_MS, requested));
  }
  return MAX_PHASE_GAP_MS;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

const CONSUME_URL_REFUSALS: Record<NavigationRefusal, [HandoffShellErrorCode, (host?: string) => string]> = {
  invalid: ["invalid_consume_url", () => "consume_url is not an absolute URL"],
  insecure: ["insecure_consume_url", () => "consume_url must be https; http is accepted only on a loopback host"],
  credentials: ["consume_url_credentials", () => "consume_url must not carry credentials"],
  host_not_allowed: ["consume_url_host_not_allowed", (host) => `consume_url host ${host} is not in allowedConsumeHosts`],
};

function assertConsumeUrl(value: string, allowedHosts: readonly string[]): string {
  const checked = checkNavigationUrl(value, allowedHosts);
  if (checked.ok) return checked.url;
  const [code, message] = CONSUME_URL_REFUSALS[checked.refusal];
  throw new HandoffShellError(code, message(checked.host), { host: checked.host, cause: checked.cause });
}

/**
 * Mount the preparation overlay, run `register`, then navigate to `consume_url`.
 * The app BFF performs registration; this package is UI only.
 *
 * On failure the overlay stays, shows the wording for the resolved language, and the promise
 * rejects with the error that caused it. An unusable `consume_url` rejects with a
 * `HandoffShellError` whose `code` names the cause; anything `register` or `assign` threw is
 * rethrown as it is.
 */
export async function openHandoffShell(options: OpenHandoffShellOptions): Promise<void> {
  const mode = options.mode ?? "quiet";
  const parent = options.parent ?? document.body;
  const text: HandoffText = resolveHandoffText(options.uiLocales, options.text);
  const title = options.title ?? text.title;
  const hint = options.hint ?? text.hint;
  const assign = options.assign ?? ((url: string) => window.location.assign(url));
  const gap = resolveGap(options.phaseGapMs);

  const root = document.createElement("div");
  root.className = "clavis-handoff";
  root.dataset.mode = mode;
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-busy", "true");

  const streamBlock =
    mode === "stream"
      ? `<p class="clavis-handoff-stream-title"></p>
         <pre class="clavis-handoff-stream" aria-live="polite"><span class="clavis-handoff-cursor" aria-hidden="true">▌</span></pre>`
      : "";

  root.innerHTML = `
    <div class="clavis-handoff-card">
      <div class="clavis-handoff-head">
        ${SPINNER}
        <div class="clavis-handoff-copy">
          <p class="clavis-handoff-title"></p>
          <p class="clavis-handoff-hint"></p>
        </div>
      </div>
      <ol class="clavis-handoff-phases" aria-live="polite"></ol>
      ${streamBlock}
      <p class="clavis-handoff-error" hidden></p>
    </div>
  `;

  const titleEl = root.querySelector(".clavis-handoff-title");
  const hintEl = root.querySelector(".clavis-handoff-hint");
  const phasesEl = root.querySelector(".clavis-handoff-phases");
  const errorEl = root.querySelector(".clavis-handoff-error");
  if (!(titleEl instanceof HTMLElement) || !(hintEl instanceof HTMLElement) || !(phasesEl instanceof HTMLOListElement) || !(errorEl instanceof HTMLElement)) {
    throw new Error("handoff shell markup missing");
  }
  const phases = phasesEl;
  const errorBox = errorEl;
  const titleText = titleEl;
  const hintText = hintEl;
  const titleId = `clavis-handoff-title-${++titleSeq}`;
  titleEl.id = titleId;
  titleEl.textContent = title;
  hintEl.textContent = hint;
  root.setAttribute("aria-labelledby", titleId);

  const streamTitleEl = root.querySelector(".clavis-handoff-stream-title");
  if (streamTitleEl instanceof HTMLElement) streamTitleEl.textContent = text.streamTitle;

  for (const id of HANDOFF_PHASE_IDS) {
    const li = document.createElement("li");
    li.dataset.phase = id;
    li.className = "clavis-handoff-phase is-todo";
    const mark = document.createElement("span");
    mark.className = "clavis-handoff-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "○";
    const label = document.createElement("span");
    label.textContent = text.phases[id];
    li.append(mark, label);
    phasesEl.appendChild(li);
  }

  const inertTargets = [...parent.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
  parent.appendChild(root);
  for (const el of inertTargets) el.inert = true;
  document.body.classList.add(BODY_OPEN);
  root.focus();

  const streamEl = root.querySelector(".clavis-handoff-stream");
  const cursor = streamEl?.querySelector(".clavis-handoff-cursor") ?? null;

  function setPhase(activeId: HandoffPhaseId): void {
    let reached = false;
    phases.querySelectorAll<HTMLElement>(".clavis-handoff-phase").forEach((li) => {
      const id = li.dataset.phase;
      const mark = li.querySelector(".clavis-handoff-mark");
      if (!mark) return;
      if (id === activeId) {
        reached = true;
        li.className = "clavis-handoff-phase is-active";
        mark.textContent = "●";
      } else if (!reached) {
        li.className = "clavis-handoff-phase is-done";
        mark.textContent = "✓";
      } else {
        li.className = "clavis-handoff-phase is-todo";
        mark.textContent = "○";
      }
    });
  }

  function completePhases(): void {
    phases.querySelectorAll(".clavis-handoff-phase").forEach((li) => {
      li.className = "clavis-handoff-phase is-done";
      const mark = li.querySelector(".clavis-handoff-mark");
      if (mark) mark.textContent = "✓";
    });
  }

  function appendLines(lines: string[]): void {
    if (!(streamEl instanceof HTMLElement) || !cursor) return;
    for (const line of lines) {
      const span = document.createElement("span");
      span.className = "clavis-handoff-line";
      span.textContent = line;
      streamEl.insertBefore(span, cursor);
    }
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  /** The overlay carries no technical reason; the thrown error carries it for the developer. */
  function setError(again: boolean): void {
    errorBox.hidden = false;
    errorBox.textContent = again ? text.errorRetry : text.errorBlocked;
    titleText.textContent = text.errorTitle;
    hintText.textContent = text.errorHint;
    root.removeAttribute("aria-busy");
  }

  function fail(error: unknown, again: boolean): never {
    setError(again);
    throw error instanceof Error ? error : new Error(String(error));
  }

  setPhase("digest");
  await sleep(gap);
  setPhase("register");
  let registered: string;
  try {
    registered = await options.register({ appendLines });
  } catch (error) {
    fail(error, true);
  }
  let consumeUrl: string;
  try {
    consumeUrl = assertConsumeUrl(registered, options.allowedConsumeHosts);
  } catch (error) {
    fail(error, false);
  }
  setPhase("connect");
  await sleep(gap);
  completePhases();
  try {
    assign(consumeUrl);
  } catch (error) {
    fail(error, false);
  }
}
