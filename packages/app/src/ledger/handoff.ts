/**
 * What is handed to the other party at the time of the transaction. The opening is never sent to
 * Clavis. `finishLedgerHandoff` adds the proof bundle (`ledger.bundle@1`) once it carries the
 * checkpoint. The verifier checks the ledger receipt and the proof bundle: the trust documents come
 * from the trust surface, and the Org log's key is the `ledger-log` key in the aggregate JWKS.
 */
import type { JWK } from "jose";
import { AppClientError, type AppClientErrorDetails } from "../errors.js";
import {
  computeLedgerCommitment,
  computeLedgerSlot,
  createLedgerOpening,
  ledgerAssetVersionSlotLabel,
  type LedgerOpening,
} from "./commitment.js";
import type { LedgerLeaf } from "./leaf.js";
import { bufferSource, fromHex, toBase64 } from "./bytes.js";
import { ledgerLeafHashHex } from "./leaf.js";
import { signLedgerAppRequest, LEDGER_APP_AUTH_SCHEME } from "./request.js";
import type { LedgerBundleFacts, Verifier } from "../verify.js";

/** A ledger proof bundle (`ledger.bundle@1`): the form the app adds the opening to, turns into a string, and passes to the verifier */
export type LedgerBundle = {
  type: "ledger.bundle@1";
  log: string;
  leaf: LedgerLeaf;
  index: number;
  /** The ledger receipt, a signed note */
  receipt: string;
  /** The checkpoint that holds the leaf, a signed note */
  checkpoint: string;
  /** The inclusion proof, as standard Base64 */
  inclusion: string[];
  opening?: LedgerOpening;
  /** The anchor: the hash of the checkpoint's body appended to the anchor log, with a TSA's proof of the time */
  anchor?: { index: number; checkpoint: string; inclusion: string[]; tsa: Array<{ url?: string; response: string }> };
};

/** The proof bundle the verifier checked, as a string, with what the verifier read from it */
export type LedgerEvidence = { bundle: string; facts: LedgerBundleFacts };

export type LedgerHandoff = {
  version: 1;
  opening: LedgerOpening;
  leaf: LedgerLeaf;
  logId: string;
  index: number;
  leafHash: string;
  receipt: string;
};

export type CommitLedgerInput = {
  record: unknown;
  /**
   * The app secret for a slot, of 32 bytes or more.
   * Pass it with `assetId` and `version`, or with `slotLabel`.
   */
  slotKey?: Uint8Array;
  assetId?: string;
  version?: number;
  slotLabel?: string;
  signal?: AbortSignal;
};

export type FinishLedgerHandoffOptions = {
  /** True by default. Wait until the proof bundle carries the checkpoint. */
  waitForCheckpoint?: boolean;
  /** False by default. Wait until the anchor's timestamp proof arrives, which takes about an hour. */
  waitForAnchor?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_CHECKPOINT_TIMEOUT_MS = 90_000;
const DEFAULT_ANCHOR_TIMEOUT_MS = 75 * 60_000;
const DEFAULT_POLL_MS = 2_000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function apiErrorDetails(body: unknown): AppClientErrorDetails {
  const rec = asRecord(body);
  if (!rec) return {};
  const details: AppClientErrorDetails = {};
  if (typeof rec.error === "string" && rec.error.length > 0) details.apiError = rec.error;
  if (typeof rec.message === "string" && rec.message.length > 0) details.apiMessage = rec.message;
  if (typeof rec.trace_id === "string" && rec.trace_id.length > 0) details.traceId = rec.trace_id;
  return details;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppClientError("invalid_json", "response body is not JSON", res.status);
  }
}

export function attachLedgerOpening(bundle: LedgerBundle, opening: LedgerOpening): LedgerBundle {
  return { ...bundle, opening };
}

export type LedgerHttp = {
  apiOrigin: string;
  appId: string;
  operateJwk: JWK;
  fetchImpl: typeof fetch;
  verifier: Verifier;
  signal?: AbortSignal;
};

async function authed(
  http: LedgerHttp,
  method: string,
  pathAndQuery: string,
  body?: Uint8Array,
): Promise<Response> {
  const jwt = await signLedgerAppRequest({
    appId: http.appId,
    operatePrivateJwk: http.operateJwk,
    method,
    pathAndQuery,
    body,
  });
  const headers: Record<string, string> = { authorization: `${LEDGER_APP_AUTH_SCHEME} ${jwt}` };
  if (body && body.length > 0) headers["content-type"] = "application/json";
  try {
    return await http.fetchImpl(`${http.apiOrigin}${pathAndQuery}`, {
      method,
      headers,
      body: body && body.length > 0 ? bufferSource(body) : undefined,
      redirect: "error",
      signal: http.signal,
    });
  } catch (e) {
    if (http.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
      throw new AppClientError("aborted", "request aborted", undefined, { cause: e });
    }
    throw new AppClientError("network_error", "request failed", undefined, { cause: e });
  }
}

export async function commitLedgerRecord(http: LedgerHttp, input: CommitLedgerInput): Promise<LedgerHandoff> {
  let opening: LedgerOpening;
  try {
    opening = createLedgerOpening(input.record);
  } catch (e) {
    throw new AppClientError("invalid_ledger_record", "record cannot be committed", undefined, { cause: e });
  }
  const c = await computeLedgerCommitment(opening);
  let slot: string | undefined;
  if (input.slotKey || input.slotLabel || input.assetId !== undefined || input.version !== undefined) {
    if (!input.slotKey) {
      throw new AppClientError("invalid_ledger_slot", "slotKey is required when a slot label is set");
    }
    const label =
      input.slotLabel ??
      (input.assetId !== undefined && input.version !== undefined
        ? ledgerAssetVersionSlotLabel(input.assetId, input.version)
        : null);
    if (!label) {
      throw new AppClientError("invalid_ledger_slot", "set slotLabel, or assetId and version");
    }
    try {
      slot = await computeLedgerSlot(input.slotKey, label);
    } catch (e) {
      throw new AppClientError("invalid_ledger_slot", "slot could not be computed", undefined, { cause: e });
    }
  }
  const leaf: LedgerLeaf = slot ? { v: 1, c, slot } : { v: 1, c };
  const raw = new TextEncoder().encode(JSON.stringify({ leaf }));
  const path = "/archive/ledger/v1/entries";
  const res = await authed(http, "POST", path, raw);
  const body = await readJson(res);
  if (!res.ok) {
    const details = apiErrorDetails(body);
    throw new AppClientError(
      "ledger_commit_failed",
      details.apiError ? `ledger HTTP ${res.status} ${details.apiError}` : `ledger HTTP ${res.status}`,
      res.status,
      details,
    );
  }
  const rec = asRecord(body);
  if (
    !rec ||
    typeof rec.log_id !== "string" ||
    typeof rec.index !== "number" ||
    typeof rec.leaf_hash !== "string" ||
    typeof rec.receipt !== "string"
  ) {
    throw new AppClientError("invalid_ledger_handoff", "commit response is missing handoff fields");
  }
  // Have the verifier check the ledger receipt, and see that it reads as this leaf appended at this position
  const expectedLeaf = await ledgerLeafHashHex(leaf);
  const note = await http.verifier.verifyLedgerNote(rec.receipt);
  if (
    note.log !== rec.log_id ||
    note.body.kind !== "receipt" ||
    note.body.index !== rec.index ||
    note.body.leaf_hash !== toBase64(fromHex(expectedLeaf))
  ) {
    throw new AppClientError("invalid_ledger_handoff", "the ledger receipt does not place this leaf at this index");
  }
  return {
    version: 1,
    opening,
    leaf,
    logId: rec.log_id,
    index: rec.index,
    leafHash: expectedLeaf,
    receipt: rec.receipt,
  };
}

function sleepDefault(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppClientError("aborted", "request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppClientError("aborted", "request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function finishLedgerHandoff(
  http: LedgerHttp,
  handoff: LedgerHandoff,
  options: FinishLedgerHandoffOptions = {},
): Promise<LedgerEvidence> {
  if (handoff.version !== 1 || !handoff.opening || !Number.isSafeInteger(handoff.index)) {
    throw new AppClientError("invalid_ledger_handoff", "handoff is not a ledger handoff");
  }
  const waitAnchor = options.waitForAnchor === true;
  const timeoutMs = options.timeoutMs ?? (waitAnchor ? DEFAULT_ANCHOR_TIMEOUT_MS : DEFAULT_CHECKPOINT_TIMEOUT_MS);
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? sleepDefault;
  const deadline = Date.now() + timeoutMs;
  const path = `/archive/ledger/v1/bundle?index=${handoff.index}`;
  for (;;) {
    const res = await authed({ ...http, signal: options.signal ?? http.signal }, "GET", path);
    const body = await readJson(res);
    if (res.status === 202) {
      if (Date.now() >= deadline) {
        throw new AppClientError("ledger_pending_timeout", "checkpoint is not ready");
      }
      await sleep(intervalMs, options.signal);
      continue;
    }
    if (!res.ok) {
      const details = apiErrorDetails(body);
      throw new AppClientError(
        "ledger_bundle_failed",
        details.apiError ? `ledger HTTP ${res.status} ${details.apiError}` : `ledger HTTP ${res.status}`,
        res.status,
        details,
      );
    }
    const rec = asRecord(body);
    const bundle = rec?.bundle as LedgerBundle | undefined;
    if (!bundle || bundle.type !== "ledger.bundle@1") {
      throw new AppClientError("invalid_ledger_handoff", "bundle response is not a ledger.bundle@1");
    }
    if (waitAnchor && rec?.anchor_status !== "stamped") {
      if (Date.now() >= deadline) {
        throw new AppClientError("ledger_pending_timeout", "anchor timestamp is not ready");
      }
      await sleep(intervalMs, options.signal);
      continue;
    }
    // Add the opening, turn it into a string, and have the verifier check it: leaf, receipt, checkpoint, inclusion, opening and anchor
    const text = JSON.stringify(attachLedgerOpening(bundle, handoff.opening));
    const facts = await http.verifier.verifyLedgerBundle(text);
    if (facts.log !== handoff.logId || facts.index !== handoff.index || !facts.opening) {
      throw new AppClientError("invalid_ledger_handoff", "the bundle is not for this handoff");
    }
    return { bundle: text, facts };
  }
}
