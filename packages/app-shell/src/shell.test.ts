import { afterEach, describe, expect, it, vi } from "vitest";
import { openHandoffShell } from "./shell.js";
import { HANDOFF_TEXT, resolveHandoffText } from "./text.js";
import { HANDOFF_PHASE_IDS } from "./types.js";

afterEach(() => {
  document.body.className = "";
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function activePhase(): string | undefined {
  return document.querySelector<HTMLElement>(".clavis-handoff-phase.is-active")?.dataset.phase;
}

function phaseLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".clavis-handoff-phase")].map((li) =>
    (li.textContent ?? "").replace(/^[○●✓]/, ""),
  );
}

function text(selector: string): string | null | undefined {
  return document.querySelector(selector)?.textContent;
}

function stubBrowserLanguages(languages: string[]): void {
  vi.stubGlobal("navigator", { ...navigator, languages, language: languages[0] });
}

describe("openHandoffShell", () => {
  it("walks digest, then register, and finishes those phases", async () => {
    const seen: string[] = [];
    await openHandoffShell({
      phaseGapMs: 0,
      register: () => {
        seen.push(activePhase() ?? "");
        expect(document.querySelector(".clavis-handoff-stream")).toBeNull();
        expect(document.body.classList.contains("clavis-handoff-open")).toBe(true);
        return Promise.resolve();
      },
    });
    expect(seen).toEqual(["register"]);
    expect(document.querySelectorAll(".is-done")).toHaveLength(HANDOFF_PHASE_IDS.length);
    expect(phaseLabels()).toEqual(HANDOFF_PHASE_IDS.map((id) => HANDOFF_TEXT.en.phases[id]));
    expect(document.querySelector(".clavis-handoff")).not.toBeNull();
  });

  it("stream mode appends lines during register", async () => {
    await openHandoffShell({
      mode: "stream",
      phaseGapMs: 0,
      uiLocales: ["ja"],
      register: ({ appendLines }) => {
        appendLines(["> register"]);
        expect(text(".clavis-handoff-stream")).toContain("> register");
        expect(text(".clavis-handoff-stream-title")).toBe(HANDOFF_TEXT.ja.streamTitle);
        return Promise.resolve();
      },
    });
  });

  it("keeps the overlay and rejects when register fails", async () => {
    await expect(
      openHandoffShell({
        phaseGapMs: 0,
        uiLocales: ["ja"],
        register: () => Promise.reject(new Error("HTTP 503")),
      }),
    ).rejects.toThrow("HTTP 503");
    const root = document.querySelector(".clavis-handoff");
    expect(root?.getAttribute("aria-busy")).toBeNull();
    expect(text(".clavis-handoff-title")).toBe(HANDOFF_TEXT.ja.errorTitle);
    expect(text(".clavis-handoff-hint")).toBe(HANDOFF_TEXT.ja.errorHint);
    expect(text(".clavis-handoff-error")).toBe(HANDOFF_TEXT.ja.errorRetry);
    expect(document.body.classList.contains("clavis-handoff-open")).toBe(true);
  });

  it("shows the viewer localized wording, never the technical reason", async () => {
    await expect(
      openHandoffShell({
        phaseGapMs: 0,
        uiLocales: ["en"],
        register: () => Promise.reject(new Error("relay down at evil.example")),
      }),
    ).rejects.toThrow("relay down at evil.example");
    expect(text(".clavis-handoff-title")).toBe(HANDOFF_TEXT.en.errorTitle);
    expect(text(".clavis-handoff-error")).toBe(HANDOFF_TEXT.en.errorRetry);
    expect(document.querySelector(".clavis-handoff-card")?.textContent).not.toContain("evil.example");
  });

  it("labels the phases in the language the caller asked for", async () => {
    for (const locale of ["en", "ja"] as const) {
      await openHandoffShell({
        phaseGapMs: 0,
        uiLocales: [locale],
        register: () => Promise.resolve(),
      });
      expect(phaseLabels()).toEqual(HANDOFF_PHASE_IDS.map((id) => HANDOFF_TEXT[locale].phases[id]));
      expect(text(".clavis-handoff-title")).toBe(HANDOFF_TEXT[locale].title);
      document.body.innerHTML = "";
    }
  });

  it("follows the browser when no language is passed", async () => {
    stubBrowserLanguages(["ja-JP", "en"]);
    await openHandoffShell({
      phaseGapMs: 0,
      register: () => Promise.resolve(),
    });
    expect(phaseLabels()).toEqual(HANDOFF_PHASE_IDS.map((id) => HANDOFF_TEXT.ja.phases[id]));
  });

  it("takes phase labels and error wording from text, and keeps title and hint on top", async () => {
    await expect(
      openHandoffShell({
        phaseGapMs: 0,
        uiLocales: ["en"],
        title: "Vorbereitung",
        text: {
          hint: "Die Anfrage wird registriert.",
          phases: { register: "Anfrage registrieren" },
          errorTitle: "Abgebrochen",
          errorRetry: "Bitte versuchen Sie es erneut.",
        },
        register: () => Promise.reject(new Error("HTTP 503")),
      }),
    ).rejects.toThrow("HTTP 503");
    expect(phaseLabels()).toEqual([HANDOFF_TEXT.en.phases.digest, "Anfrage registrieren"]);
    expect(text(".clavis-handoff-title")).toBe("Abgebrochen");
    expect(text(".clavis-handoff-error")).toBe("Bitte versuchen Sie es erneut.");
  });

  it("keeps title and hint over the resolved language while registration runs", async () => {
    await openHandoffShell({
      phaseGapMs: 0,
      uiLocales: ["ja"],
      title: "権限の付与",
      hint: "内容を確認しています。",
      register: () => {
        expect(text(".clavis-handoff-title")).toBe("権限の付与");
        expect(text(".clavis-handoff-hint")).toBe("内容を確認しています。");
        return Promise.resolve();
      },
    });
  });

  it("does not offer a handoff phase", () => {
    expect([...HANDOFF_PHASE_IDS]).toEqual(["digest", "register"]);
    const copy = JSON.stringify(HANDOFF_TEXT);
    expect(copy).not.toContain("Hand over to Connect");
    expect(copy).not.toContain("Connect へ");
  });
});

describe("resolveHandoffText", () => {
  it("matches on the primary subtag, in the order given", () => {
    expect(resolveHandoffText(["de", "ja-JP", "en"])).toBe(HANDOFF_TEXT.ja);
    expect(resolveHandoffText(["en_GB"])).toBe(HANDOFF_TEXT.en);
  });

  it("falls back to the browser, then to en", () => {
    stubBrowserLanguages(["ja"]);
    expect(resolveHandoffText()).toBe(HANDOFF_TEXT.ja);
    expect(resolveHandoffText(["de"])).toBe(HANDOFF_TEXT.ja);
    stubBrowserLanguages(["de-CH"]);
    expect(resolveHandoffText()).toBe(HANDOFF_TEXT.en);
  });

  it("shares the phase keys across the bundled languages and writes each language on its own", () => {
    expect(Object.keys(HANDOFF_TEXT.ja.phases)).toEqual(Object.keys(HANDOFF_TEXT.en.phases));
    for (const id of HANDOFF_PHASE_IDS) {
      expect(HANDOFF_TEXT.ja.phases[id]).not.toBe(HANDOFF_TEXT.en.phases[id]);
    }
  });

  it("ignores undefined override keys", () => {
    const resolved = resolveHandoffText(["en"], { title: undefined, phases: { digest: undefined } });
    expect(resolved.title).toBe(HANDOFF_TEXT.en.title);
    expect(resolved.phases.digest).toBe(HANDOFF_TEXT.en.phases.digest);
  });
});
