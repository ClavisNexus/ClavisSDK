/** Why a URL will not be opened */
export type NavigationRefusal = "invalid" | "insecure" | "credentials" | "host_not_allowed";

export type NavigationCheck =
  | { ok: true; url: string }
  | { ok: false; refusal: NavigationRefusal; host?: string; cause?: unknown };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the shell or the button may navigate to `value`: an absolute https URL (http only on a
 * loopback host), without a user name or password, on one of `allowedHosts`.
 */
export function checkNavigationUrl(value: unknown, allowedHosts: readonly string[]): NavigationCheck {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch (cause) {
    return { ok: false, refusal: "invalid", cause };
  }
  if (typeof value !== "string") return { ok: false, refusal: "invalid" };
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(host))) {
    return { ok: false, refusal: "insecure", host };
  }
  if (url.username || url.password) return { ok: false, refusal: "credentials", host };
  if (!allowedHosts.some((item) => typeof item === "string" && item.trim().toLowerCase() === host)) {
    return { ok: false, refusal: "host_not_allowed", host };
  }
  return { ok: true, url: url.toString() };
}
