# `@clavis.nexus/app-shell`

Browser handoff shell (ESM). This package advances the phases from waiting on signature-request registration through the move to `consume_url`.

Registration on the server is [`@clavis.nexus/app`](https://www.npmjs.com/package/@clavis.nexus/app). Pass your own BFF as `register`. Its return value is `consume_url`. Leave `poll_secret` out of the BFF's JSON.

## Install

```bash
npm install @clavis.nexus/app-shell
```

The CSS is `import "@clavis.nexus/app-shell/styles.css"`.

## Handoff

```ts
import { openHandoffShell } from "@clavis.nexus/app-shell";
import "@clavis.nexus/app-shell/styles.css";

await openHandoffShell({
  allowedConsumeHosts: ["api.clavis.nexus"],
  async register() {
    const res = await fetch("/api/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body: unknown = await res.json();
    if (
      !res.ok ||
      !body ||
      typeof body !== "object" ||
      !("consume_url" in body) ||
      typeof body.consume_url !== "string"
    ) {
      const code =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
      throw new Error(code);
    }
    return body.consume_url;
  },
});
```

Pass the host of `consume_url` (`api.clavis.nexus`) in `allowedConsumeHosts`. The shell navigates only to an https URL on that host. `http` is accepted only on a loopback host.

The default mode is `quiet`. On success it opens `consume_url` with `location.assign`. The overlay stays until that navigation.

On failure the overlay stays and shows the error wording of the language it resolved. The viewer sees no technical reason; the promise rejects with it instead. See [Failures](#failures).

When `prefers-reduced-motion: reduce` matches, the gap between phases is 0.

The title and the hint come from the resolved language. Pass `title` and `hint` to replace them with your own wording for this one handoff; they win over `uiLocales` and `text`.

## Phases

The order is fixed and matches `HANDOFF_PHASE_IDS`. The labels come from the resolved language, keyed by id.

| id | `en` | `ja` |
|----|------|------|
| `digest` | Prepare the details | 内容を準備 |
| `register` | Register the request | 署名依頼を登録 |
| `connect` | Hand over to Connect | Connect へ |

## Screen language

The package ships `en` and `ja`. Pass BCP 47 language tags in `uiLocales`, in order of preference — the same list you give `uiLocales` on [`@clavis.nexus/app`](https://www.npmjs.com/package/@clavis.nexus/app), so this overlay and Connect's confirmation screen read alike.

```ts
await openHandoffShell({
  uiLocales: ["ja"],
  allowedConsumeHosts: ["api.clavis.nexus"],
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
    phases: { digest: "Inhalt vorbereiten", register: "Anfrage registrieren", connect: "Weiter zu Connect" },
    errorTitle: "Abgebrochen",
    errorHint: "Es wurde nichts signiert.",
    errorRetry: "Bitte versuchen Sie es erneut.",
    errorBlocked: "Bitte wenden Sie sich an den Support dieser Seite.",
  },
  allowedConsumeHosts: ["api.clavis.nexus"],
  register,
});
```

`HANDOFF_TEXT` holds the bundled wording (`HANDOFF_TEXT.en`, `HANDOFF_TEXT.ja`) and `resolveHandoffText(uiLocales, text)` returns what the overlay would use, for a screen of your own around it.

## Failures

The promise rejects with the error that stopped the handoff. The overlay keeps its own wording: the head becomes `errorTitle` and `errorHint`, and the line below says `errorRetry` when another attempt may get through, or `errorBlocked` when it will not.

Whatever `register` throws is rethrown as it is, so your BFF's own error reaches your `catch` and your logs. A `consume_url` the shell will not open rejects with `HandoffShellError`, whose `code` names the cause.

| `code` | Cause |
|--------|-------|
| `invalid_consume_url` | Not an absolute URL. `cause` carries what `new URL()` threw |
| `insecure_consume_url` | Not `https`, and not `http` on a loopback host |
| `consume_url_credentials` | Carries a user name or password |
| `consume_url_host_not_allowed` | Host is not in `allowedConsumeHosts`. `host` carries it |

```ts
import { HandoffShellError, openHandoffShell } from "@clavis.nexus/app-shell";

try {
  await openHandoffShell({ allowedConsumeHosts: ["api.clavis.nexus"], register });
} catch (error) {
  if (error instanceof HandoffShellError) {
    console.error(error.code, error.host);
  }
}
```

## stream

To show a progress log, set `mode: "stream"`. Pass strings to `appendLines`.

```ts
await openHandoffShell({
  mode: "stream",
  allowedConsumeHosts: ["api.clavis.nexus"],
  async register({ appendLines }) {
    const res = await fetch("/api/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body: unknown = await res.json();
    if (
      !res.ok ||
      !body ||
      typeof body !== "object" ||
      !("consume_url" in body) ||
      typeof body.consume_url !== "string"
    ) {
      throw new Error(`HTTP ${res.status}`);
    }
    if ("request_id" in body && typeof body.request_id === "string") appendLines([body.request_id]);
    return body.consume_url;
  },
});
```

## Colour

Layout and phase order are fixed. Colour, corner radius and font can be inherited through CSS variables.

`--clavis-handoff-bg`, `--clavis-handoff-surface`, `--clavis-handoff-surface-muted`, `--clavis-handoff-text`, `--clavis-handoff-text-muted`, `--clavis-handoff-text-subtle`, `--clavis-handoff-border`, `--clavis-handoff-brand`, `--clavis-handoff-error`, `--clavis-handoff-radius`, `--clavis-handoff-font`, `--clavis-handoff-mono`.

## License

MIT. Copyright (c) 2026 DeepDive, Inc.
