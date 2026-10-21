import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Open only https, or http on a loopback host. Credentials in the URL are refused. */
export function assertOpenableBrowserUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("invalid URL");
  }
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("only https URLs may be opened in a browser");
  }
  return url.toString();
}

/**
 * On Windows this never goes through cmd.exe.
 * A `&` or `|` in the query sits inside PowerShell single quotes, so it cannot separate commands.
 */
export function windowsBrowserArgs(raw: string): string[] {
  const url = assertOpenableBrowserUrl(raw);
  const script = `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

/** Open a URL in the default browser (macOS / Windows / Linux). */
export async function openBrowser(url: string): Promise<void> {
  const safe = assertOpenableBrowserUrl(url);
  if (process.platform === "darwin") {
    await execFileAsync("open", [safe]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", windowsBrowserArgs(safe));
    return;
  }
  await execFileAsync("xdg-open", [safe]);
}
