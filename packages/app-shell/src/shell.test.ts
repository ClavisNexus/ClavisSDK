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
  it("walks digest, register, then connect before assign", async () => {
    const seen: string[] = [];
    let assigned = "";
    await openHandoffShell({
      phaseGapMs: 0,
      allowedConsumeHosts: ["api.example"],
      assign: (url) => {
        assigned = url;
        seen.push(activePhase() ?? "done");
        expect(document.querySelectorAll(".is-done")).toHaveLength(HANDOFF_PHASE_IDS.length);
      },
      register: () => {
        seen.push(activePhase() ?? "");
        expect(document.querySelector(".clavis-handoff-stream")).toBeNull();
        expect(document.body.classList.contains("clavis-handoff-open")).toBe(true);
        return Promise.resolve("https://api.example/consume");
      },
    });
    expect(seen).toEqual(["register", "done"]);
    expect(assigned).toBe("https://api.example/consume");
    expect(document.querySelector(".clavis-handoff")).not.toBeNull();
  });

  it("stream mode appends lines during register", async () => {
    await openHandoffShell({
      mode: "stream",
      phaseGapMs: 0,
      uiLocales: ["ja"],
      allowedConsumeHosts: ["api.example"],
      assign: () => undefined,
      register: ({ appendLines }) => {
        appendLines(["> register"]);
        expect(text(".clavis-handoff-stream")).toContain("> register");
        expect(text(".clavis-handoff-stream-title")).toBe(HANDOFF_TEXT.ja.streamTitle);
        return Promise.resolve("https://api.example/consume");
      },
    });
  });

  it("keeps the overlay and rejects when register fails", async () => {
    const assign = () => {
      throw new Error("assign should not run");
    };
    await expect(
      openHandoffShell({
        phaseGapMs: 0,
        uiLocales: ["ja"],
        allowedConsumeHosts: ["api.example"],
        assign,
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
        allowedConsumeHosts: ["api.example"],
        assign: () => undefined,
        register: () => Promise.resolve("https://evil.example/consume"),
      }),
    ).rejects.toMatchObject({ code: "consume_url_host_not_allowed" });
    expect(text(".clavis-handoff-title")).toBe(HANDOFF_TEXT.en.errorTitle);
    expect(text(".clavis-handoff-error")).toBe(HANDOFF_TEXT.en.errorBlocked);
    expect(document.querySelector(".clavis-handoff-card")?.textContent).not.toContain("evil.example");
  });

  it("names the cause of an unusable consume_url in code", async () => {
    const cases: Array<[string, string]> = [
      ["not a url", "invalid_consume_url"],
      ["http://api.example/consume", "insecure_consume_url"],
      ["https://user:pw@api.example/consume", "consume_url_credentials"],
      ["https://evil.example/consume", "consume_url_host_not_allowed"],
    ];
    for (const [consumeUrl, code] of cases) {
      await expect(
        openHandoffShell({
          phaseGapMs: 0,
          allowedConsumeHosts: ["api.example"],
          assign: () => undefined,
          register: () => Promise.resolve(consumeUrl),
        }),
      ).rejects.toMatchObject({ name: "HandoffShellError", code });
      document.body.innerHTML = "";
    }
  });

  it("accepts cleartext consume_url on a loopback host", async () => {
    let assigned = "";
    await openHandoffShell({
      phaseGapMs: 0,
      allowedConsumeHosts: ["localhost"],
      assign: (url) => {
        assigned = url;
      },
      register: () => Promise.resolve("http://localhost:8787/consume"),
    });
    expect(assigned).toBe("http://localhost:8787/consume");
  });

  it("labels the phases in the language the caller asked for", async () => {
    for (const locale of ["en", "ja"] as const) {
      await openHandoffShell({
        phaseGapMs: 0,
        uiLocales: [locale],
        allowedConsumeHosts: ["api.example"],
        assign: () => undefined,
        register: () => Promise.resolve("https://api.example/consume"),
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
      allowedConsumeHosts: ["api.example"],
      assign: () => undefined,
      register: () => Promise.resolve("https://api.example/consume"),
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
          phases: { connect: "Weiter zu Connect" },
          errorTitle: "Abgebrochen",
          errorBlocked: "Bitte wenden Sie sich an den Support.",
        },
        allowedConsumeHosts: ["api.example"],
        assign: () => undefined,
        register: () => Promise.resolve("https://evil.example/consume"),
      }),
    ).rejects.toMatchObject({ code: "consume_url_host_not_allowed" });
    expect(phaseLabels()).toEqual([
      HANDOFF_TEXT.en.phases.digest,
      HANDOFF_TEXT.en.phases.register,
      "Weiter zu Connect",
    ]);
    expect(text(".clavis-handoff-title")).toBe("Abgebrochen");
    expect(text(".clavis-handoff-error")).toBe("Bitte wenden Sie sich an den Support.");
  });

  it("keeps title and hint over the resolved language while the handoff runs", async () => {
    await openHandoffShell({
      phaseGapMs: 0,
      uiLocales: ["ja"],
      title: "権限の付与",
      hint: "内容を確認しています。",
      allowedConsumeHosts: ["api.example"],
      assign: () => undefined,
      register: () => {
        expect(text(".clavis-handoff-title")).toBe("権限の付与");
        expect(text(".clavis-handoff-hint")).toBe("内容を確認しています。");
        return Promise.resolve("https://api.example/consume");
      },
    });
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
