import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAVIS_BUTTON_TEXT,
  ClavisButtonError,
  mountClavisButton,
  renderClavisButtonHtml,
  type ClavisButtonTheme,
  type ClavisButtonTone,
  type MountClavisButtonOptions,
} from "./index.js";
import { MARK_PATHS } from "./mark.generated.js";
import { CLAVIS_LINK_BUTTON_TEXT } from "./text.js";

const here = (file: string) => join(dirname(fileURLToPath(import.meta.url)), file);
const fontRecord = JSON.parse(readFileSync(here("clavis-button-grotesk.json"), "utf8")) as {
  text: string;
  unicodeRange: string;
  sha256: string;
};
const css = readFileSync(here("button.css"), "utf8");

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TONES: ClavisButtonTone[] = ["primary", "secondary"];
const THEMES: ClavisButtonTheme[] = ["light", "dark", "auto"];
const LANGS = ["ja", "en"] as const;

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(over: Partial<MountClavisButtonOptions> = {}) {
  const el = host();
  const assign = vi.fn();
  const start = vi.fn(async () => "https://api.clavis.nexus/oauth/authorize?client_id=app");
  const handle = mountClavisButton(el, { tone: "primary", uiLocales: ["ja"], allowedHosts: ["api.clavis.nexus"], start, assign, ...over });
  const note = () => el.querySelector(".clavis-button-note")!.textContent;
  return { el, handle, assign, start, note };
}

function stubBrowserLanguages(languages: string[]): void {
  vi.stubGlobal("navigator", { ...navigator, languages, language: languages[0] });
}

describe("renderClavisButtonHtml", () => {
  it("draws every tone, theme and language with its own wording", () => {
    for (const tone of TONES) {
      for (const theme of THEMES) {
        for (const lang of LANGS) {
          const el = host();
          el.innerHTML = renderClavisButtonHtml({ tone, theme, uiLocales: [lang] });
          const root = el.querySelector<HTMLElement>(".clavis-button-root")!;
          const button = root.querySelector("button")!;
          expect(root.dataset).toMatchObject({ theme, width: "content" });
          expect(root.lang).toBe(lang);
          expect(button.type).toBe("button");
          expect({ ...button.dataset }).toEqual({ tone });
          expect(button.textContent).toBe(CLAVIS_BUTTON_TEXT[lang].label);
          expect(root.querySelectorAll(".clavis-button-mark path")).toHaveLength(MARK_PATHS.length);
          expect(root.querySelector(".clavis-button-mark")!.getAttribute("aria-hidden")).toBe("true");
          expect(root.querySelector(".clavis-button-note")!.textContent).toBe("");
          el.remove();
        }
      }
    }
  });

  it("writes the label for each language", () => {
    expect(CLAVIS_BUTTON_TEXT.ja.label).toBe("Clavis でサインイン");
    expect(CLAVIS_BUTTON_TEXT.en.label).toBe("Sign in with Clavis");
  });

  it("renders and mounts the link action in its own language", async () => {
    const markup = renderClavisButtonHtml({ tone: "primary", kind: "link", uiLocales: ["en"] });
    expect(markup).toContain(">Link your Clavis account<");
    const { handle, note } = mount({
      kind: "link",
      start: async () => { throw new Error("could not start"); },
    });
    expect(handle.button.textContent).toBe("Clavis と連携");
    await expect(handle.press()).rejects.toThrow("could not start");
    expect(note()).toBe(CLAVIS_LINK_BUTTON_TEXT.ja.retry);
  });

  it("defaults to auto and the label's width, and fills the column when fluid", () => {
    const html = renderClavisButtonHtml({ tone: "secondary", uiLocales: ["en-GB"] });
    expect(html).toContain('data-theme="auto"');
    expect(html).toContain('data-width="content"');
    expect(html).toContain('lang="en"');
    expect(renderClavisButtonHtml({ tone: "secondary", width: "fluid" })).toContain('data-width="fluid"');
  });

  it("follows the browser's languages, then en", () => {
    stubBrowserLanguages(["fr-FR", "ja-JP"]);
    expect(renderClavisButtonHtml({ tone: "primary" })).toContain(">Clavis でサインイン<");
    expect(renderClavisButtonHtml({ tone: "primary", uiLocales: ["de"] })).toContain(">Clavis でサインイン<");
    stubBrowserLanguages(["fr-FR"]);
    expect(renderClavisButtonHtml({ tone: "primary" })).toContain(">Sign in with Clavis<");
  });

  it("carries no script, frame, image, style attribute or address", () => {
    const html = renderClavisButtonHtml({ tone: "primary", theme: "dark", uiLocales: ["ja"] });
    expect(html).not.toMatch(/<(script|iframe|img|link|object|embed|image|use)\b/i);
    expect(html).not.toMatch(/\b(src|href|srcset|style|on\w+)=/i);
    expect(html).not.toMatch(/https?:|\/\//);
  });

  it("refuses options the button does not offer", () => {
    expect(() => renderClavisButtonHtml({ tone: "ghost" as ClavisButtonTone })).toThrow(TypeError);
    expect(() => renderClavisButtonHtml({ tone: "primary", theme: "sepia" as ClavisButtonTheme })).toThrow(TypeError);
    expect(() => renderClavisButtonHtml({ tone: "primary", width: "wide" as "fluid" })).toThrow(TypeError);
  });
});

describe("mountClavisButton", () => {
  it("puts the same markup renderClavisButtonHtml writes, and sends nothing before the press", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cookie = document.cookie;
    const { el, start } = mount({ tone: "secondary", theme: "light", width: "fluid", uiLocales: ["en"] });
    expect(el.innerHTML).toBe(renderClavisButtonHtml({ tone: "secondary", theme: "light", width: "fluid", uiLocales: ["en"] }));
    expect(start).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
    expect(document.querySelectorAll("script, iframe, img, link")).toHaveLength(0);
  });

  it("replaces markup rendered on the server", () => {
    const el = host();
    el.innerHTML = renderClavisButtonHtml({ tone: "primary", uiLocales: ["ja"] });
    mountClavisButton(el, { tone: "primary", uiLocales: ["ja"], allowedHosts: ["api.clavis.nexus"], start: async () => "", assign: () => {} });
    expect(el.querySelectorAll(".clavis-button-root")).toHaveLength(1);
  });

  it("waits inside the button at once, calls start once, and navigates", async () => {
    const pending = deferred<string>();
    const start = vi.fn(() => pending.promise);
    const { handle, assign } = mount({ start });
    handle.button.click();
    expect(handle.button.getAttribute("aria-busy")).toBe("true");
    expect(handle.button.getAttribute("aria-disabled")).toBe("true");
    handle.button.click();
    handle.button.click();
    expect(start).toHaveBeenCalledTimes(1);
    pending.resolve("https://api.clavis.nexus/oauth/authorize?client_id=app&state=s");
    await handle.press();
    expect(assign).toHaveBeenCalledWith("https://api.clavis.nexus/oauth/authorize?client_id=app&state=s");
    // 移るまで待ったまま
    expect(handle.button.getAttribute("aria-busy")).toBe("true");
  });

  it("opens only https on allowedHosts, and http only on loopback", async () => {
    const cases: Array<[string, string | null]> = [
      ["https://evil.example/oauth/authorize", "start_url_host_not_allowed"],
      ["http://api.clavis.nexus/oauth/authorize", "insecure_start_url"],
      ["javascript:alert(1)", "insecure_start_url"],
      ["https://user:pw@api.clavis.nexus/x", "start_url_credentials"],
      ["/relative", "invalid_start_url"],
      ["http://localhost:8787/oauth/authorize", null],
      ["https://API.Clavis.Nexus/oauth/authorize", null],
    ];
    for (const [url, code] of cases) {
      const { handle, assign, note } = mount({ allowedHosts: ["api.clavis.nexus", "localhost"], start: async () => url, uiLocales: ["en"] });
      if (code) {
        await expect(handle.press()).rejects.toMatchObject({ name: "ClavisButtonError", code });
        expect(assign).not.toHaveBeenCalled();
        expect(note()).toBe(CLAVIS_BUTTON_TEXT.en.blocked);
        expect(handle.button.hasAttribute("aria-busy")).toBe(false);
      } else {
        await handle.press();
        expect(assign).toHaveBeenCalledTimes(1);
      }
      handle.unmount();
    }
  });

  it("shows one line in the viewer's language when start fails, and rejects with the reason", async () => {
    const reason = new Error("HTTP 503 from /auth/clavis/start");
    for (const lang of LANGS) {
      const onError = vi.fn();
      const { handle, note, assign } = mount({ uiLocales: [lang], start: async () => Promise.reject(reason), onError });
      await expect(handle.press()).rejects.toBe(reason);
      expect(note()).toBe(CLAVIS_BUTTON_TEXT[lang].retry);
      expect(note()).not.toContain("503");
      expect(handle.button.hasAttribute("aria-busy")).toBe(false);
      expect(assign).not.toHaveBeenCalled();
      handle.unmount();
    }
  });

  it("hands a failed click to onError, and lets the next press try again with the line cleared", async () => {
    const reason = new Error("offline");
    const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(reason).mockResolvedValueOnce("https://api.clavis.nexus/oauth/authorize?state=s2");
    const onError = vi.fn();
    const { handle, note, assign } = mount({ start, onError });
    handle.button.click();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(reason));
    expect(note()).toBe(CLAVIS_BUTTON_TEXT.ja.retry);
    handle.button.click();
    expect(note()).toBe("");
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://api.clavis.nexus/oauth/authorize?state=s2"));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("frees the button when start throws before returning a promise", async () => {
    let first = true;
    const { handle } = mount({
      start: () => {
        if (first) {
          first = false;
          throw new Error("sync");
        }
        return Promise.resolve("https://api.clavis.nexus/oauth/authorize");
      },
    });
    await expect(handle.press()).rejects.toThrow("sync");
    await Promise.resolve();
    await expect(handle.press()).resolves.toBeUndefined();
  });

  it("shows the blocked line when assign throws", async () => {
    const { handle, note } = mount({
      uiLocales: ["en"],
      assign: () => {
        throw new Error("navigation blocked");
      },
    });
    await expect(handle.press()).rejects.toThrow("navigation blocked");
    expect(note()).toBe(CLAVIS_BUTTON_TEXT.en.blocked);
  });

  it("stops waiting when the page comes back from the back-forward cache", async () => {
    const { handle } = mount();
    await handle.press();
    expect(handle.button.getAttribute("aria-busy")).toBe("true");
    const event = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
    expect(handle.button.hasAttribute("aria-busy")).toBe(false);
  });

  it("unmounts its markup and listeners", () => {
    const { el, handle, start } = mount();
    const button = handle.button;
    handle.unmount();
    expect(el.children).toHaveLength(0);
    button.click();
    expect(start).not.toHaveBeenCalled();
  });

  it("needs start and allowedHosts", () => {
    const el = host();
    expect(() => mountClavisButton(el, { tone: "primary" } as MountClavisButtonOptions)).toThrow(TypeError);
    expect(() => mountClavisButton(el, { tone: "primary", start: async () => "" } as unknown as MountClavisButtonOptions)).toThrow(TypeError);
  });

  it("exports the error class", () => {
    expect(new ClavisButtonError("invalid_start_url", "x").code).toBe("invalid_start_url");
  });
});

describe("button.css", () => {
  it("keeps the shape fixed: corners 0, 44px high, no shadow, colour-only hover, a 2px focus ring", () => {
    expect(css).toMatch(/\.clavis-button \{[^}]*border-radius: 0;/);
    expect(css).toMatch(/\.clavis-button \{[^}]*block-size: 44px;/);
    expect(css).toMatch(/\.clavis-button \{[^}]*box-shadow: none;/);
    expect(css).toMatch(/transition:\s*background-color 160ms ease,\s*color 160ms ease;/);
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--clavis-button-wet\);/);
    expect(css).not.toMatch(/(?<!-)transform:|scale\(|translate/);
    expect(css).not.toMatch(/url\((?!"\.\/clavis-button-grotesk\.woff2")/);
  });

  it("thickens the waiting mark's lines by 1.25 and stills them under reduced motion", () => {
    for (const p of MARK_PATHS) {
      const width = Math.round(p.width * 1.25 * 100) / 100;
      expect(css).toContain(`path[data-kind="${p.kind}"] {\n  stroke-width: ${width};`);
    }
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*animation: none;/);
  });

  it("names the label font's characters, and the font covers the Latin letters of every label", () => {
    expect(css).toContain(`unicode-range: ${fontRecord.unicodeRange};`);
    const latin = new Set(
      [...Object.values(CLAVIS_BUTTON_TEXT), ...Object.values(CLAVIS_LINK_BUTTON_TEXT)]
        .map((t) => t.label)
        .join("")
        .split("")
        .filter((c) => c >= " " && c <= "~"),
    );
    expect([...latin].sort().join("")).toBe(fontRecord.text);
  });

  it("ships the font file its record names", () => {
    const bytes = readFileSync(here("clavis-button-grotesk.woff2"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fontRecord.sha256);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
  });
});
