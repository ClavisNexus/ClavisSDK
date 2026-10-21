import type { Receipt } from "./types.js";
import type { Statement } from "./statements.js";

/** Take the receipt out of the ceremony's result, as the holder receipt `receipt@1` in string form. Clavis checks it when it receives it. */
export function receiptFromCeremonyPayload(payload: unknown): Receipt {
  if (typeof payload !== "string" || payload.length === 0) {
    throw new Error("Passkey confirmation did not return a receipt.");
  }
  return payload;
}

/**
 * Send the statement and take a ticket (`POST /webauthn/authentication/ceremony/start`).
 * A person uses their passkey at `/auth/ceremony?ticket=` on id, and Clavis puts the receipt on the
 * ticket.
 */
export async function startCeremony(args: {
  apiOrigin: string;
  bearer: string;
  returnTo: string;
  statement: Statement;
}): Promise<{ ticket: string; expires_in?: number }> {
  const res = await fetch(`${args.apiOrigin.replace(/\/+$/, "")}/webauthn/authentication/ceremony/start`, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.bearer}`,
    },
    body: JSON.stringify({ return_to: args.returnTo, statement: args.statement }),
  });
  const body = (await res.json().catch(() => null)) as {
    payload?: { ticket?: string; expires_in?: number };
    error?: string;
    message?: string;
  } | null;
  if (!res.ok || typeof body?.payload?.ticket !== "string") {
    throw new Error(body?.message ?? body?.error ?? `Passkey confirmation failed (HTTP ${res.status})`);
  }
  return { ticket: body.payload.ticket, expires_in: body.payload.expires_in };
}

/** Wait for the ceremony's result, the receipt (`POST /webauthn/authentication/ceremony/result`). */
export async function pollCeremonyResult(args: {
  apiOrigin: string;
  bearer: string;
  ticket: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<unknown> {
  const timeoutMs = args.timeoutMs ?? 5 * 60_000;
  const intervalMs = args.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let lastError = "Passkey confirmation timed out. Complete it in the browser, then retry.";

  while (Date.now() < deadline) {
    const res = await fetch(`${args.apiOrigin.replace(/\/+$/, "")}/webauthn/authentication/ceremony/result`, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.bearer}`,
      },
      body: JSON.stringify({ ticket: args.ticket }),
    });
    const body = (await res.json().catch(() => null)) as {
      payload?: { receipt?: unknown };
      error?: string;
      message?: string;
    } | null;

    if (res.ok && body?.payload !== undefined) {
      return body.payload.receipt;
    }

    if (res.status === 404) {
      lastError = body?.message ?? "waiting for Passkey";
      await sleep(intervalMs);
      continue;
    }

    throw new Error(body?.message ?? body?.error ?? `Passkey confirmation failed (HTTP ${res.status})`);
  }

  throw new Error(lastError);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ceremonyPageUrl(idOrigin: string, ticket: string): string {
  const u = new URL("/auth/ceremony", idOrigin.replace(/\/+$/, ""));
  u.searchParams.set("ticket", ticket);
  return u.toString();
}

export function setupCeremonyReturnTo(developersOrigin: string): string {
  return `${developersOrigin.replace(/\/+$/, "")}/developers/setup/ceremony`;
}
