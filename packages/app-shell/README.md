# `@clavis.nexus/app-shell`

Browser preparation overlay (ESM). This package shows the phases while a signature request is registered.

Registration on the server is [`@clavis.nexus/app`](https://www.npmjs.com/package/@clavis.nexus/app). Pass your own BFF as `register`.

## Install

```bash
npm install @clavis.nexus/app-shell
```

The CSS is `import "@clavis.nexus/app-shell/styles.css"`.

## Prepare

```ts
import { openHandoffShell } from "@clavis.nexus/app-shell";
import "@clavis.nexus/app-shell/styles.css";

await openHandoffShell({
  async register() {
    const res = await fetch("/api/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
});
```

The default mode is `quiet`. On success the phases are marked done and the overlay stays.

On failure the overlay stays and shows the error wording of the language it resolved. The viewer sees no technical reason; the promise rejects with it instead.

When `prefers-reduced-motion: reduce` matches, the gap between phases is 0.

The title and the hint come from the resolved language. Pass `title` and `hint` to replace them with your own wording for this one run; they win over `uiLocales` and `text`.

## Phases

The order is fixed and matches `HANDOFF_PHASE_IDS`. The labels come from the resolved language, keyed by id.

| id | `en` | `ja` |
|----|------|------|
| `digest` | Prepare the details | 内容を準備 |
| `register` | Register the request | 署名依頼を登録 |

## Screen language

The package ships `en` and `ja`. Pass BCP 47 language tags in `uiLocales`, in order of preference.

```ts
await openHandoffShell({
  uiLocales: ["ja"],
  register,
});
```

Matching is on the primary subtag, so `en-GB` resolves `en`. When none of the tags is a language this package ships, it follows the browser's languages, then `en`. Omitting `uiLocales` follows the same rule.

For a language this package does not ship, or to reword single keys, pass `text`. It goes over the resolved language key by key.

```ts
await openHandoffShell({
  uiLocales: ["de"],
  text: {
    title: "Signatur vorbereiten",
    hint: "Die Anfrage wird registriert.",
    streamTitle: "Fortschritt",
    phases: { digest: "Inhalt vorbereiten", register: "Anfrage registrieren" },
    errorTitle: "Abgebrochen",
    errorHint: "Es wurde nichts signiert.",
    errorRetry: "Bitte versuchen Sie es erneut.",
    errorBlocked: "Bitte wenden Sie sich an den Support dieser Seite.",
  },
  register,
});
```

`HANDOFF_TEXT` holds the bundled wording (`HANDOFF_TEXT.en`, `HANDOFF_TEXT.ja`) and `resolveHandoffText(uiLocales, text)` returns what the overlay would use, for a screen of your own around it.

## Failures

The promise rejects with the error that stopped registration. The overlay keeps its own wording: the head becomes `errorTitle` and `errorHint`, and the line below says `errorRetry`.

Whatever `register` throws is rethrown as it is, so your BFF's own error reaches your `catch` and your logs.

## stream

To show a progress log, set `mode: "stream"`. Pass strings to `appendLines`.

```ts
await openHandoffShell({
  mode: "stream",
  async register({ appendLines }) {
    const res = await fetch("/api/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    appendLines(["registered"]);
  },
});
```

## Colour

Layout and phase order are fixed. Colour, corner radius and font can be inherited through CSS variables.

`--clavis-handoff-bg`, `--clavis-handoff-surface`, `--clavis-handoff-surface-muted`, `--clavis-handoff-text`, `--clavis-handoff-text-muted`, `--clavis-handoff-text-subtle`, `--clavis-handoff-border`, `--clavis-handoff-brand`, `--clavis-handoff-error`, `--clavis-handoff-radius`, `--clavis-handoff-font`, `--clavis-handoff-mono`.

## License

MIT. Copyright (c) 2026 DeepDive, Inc.
