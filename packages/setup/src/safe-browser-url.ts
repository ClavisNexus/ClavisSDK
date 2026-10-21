/** Browser open targets: https only, no embedded credentials. Loopback http is for a local id origin. */

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function parseBrowserUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("invalid URL");
  }
  if (u.username || u.password) {
    throw new Error("URL must not contain credentials");
  }
  return u;
}

/** The card checkout URL. Only the host the API returned is opened. */
export function assertCardCheckoutBrowserUrl(raw: string): string {
  const u = parseBrowserUrl(raw);
  if (u.protocol !== "https:") {
    throw new Error("only https URLs may be opened in a browser");
  }
  const host = u.hostname.toLowerCase();
  if (host !== "polar.sh" && !host.endsWith(".polar.sh")) {
    throw new Error("checkout URL host is not allowed");
  }
  return u.toString();
}

/** Open only a URL on the given origin. http is accepted on a loopback host only. */
export function assertOriginBrowserUrl(raw: string, origin: string): string {
  const u = parseBrowserUrl(raw);
  let expected: URL;
  try {
    expected = new URL(origin.trim());
  } catch {
    throw new Error("invalid expected origin");
  }
  if (expected.username || expected.password) {
    throw new Error("expected origin must not contain credentials");
  }
  const loopback = isLoopbackHost(expected.hostname);
  const https = expected.protocol === "https:" && u.protocol === "https:";
  const loopbackHttp = loopback && expected.protocol === "http:" && u.protocol === "http:";
  if (!https && !loopbackHttp) {
    throw new Error("only https URLs may be opened in a browser");
  }
  if (u.origin !== expected.origin) {
    throw new Error("URL origin does not match the expected origin");
  }
  return u.toString();
}
