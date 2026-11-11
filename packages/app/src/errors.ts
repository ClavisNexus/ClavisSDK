export type AppClientErrorCode =
  | "invalid_api_origin"
  | "invalid_operate_jwk"
  | "invalid_app_id"
  | "removed_option"
  | "invalid_trust_root"
  | "invalid_trust_origin"
  | "trust_unavailable"
  | "verifier_unavailable"
  | "invalid_verifier"
  | "invalid_entity_id"
  | "invalid_request_jwk"
  | "invalid_sign_input"
  | "sign_failed"
  | "invalid_sign_response"
  | "invalid_status_args"
  | "receipt_invalid"
  | "anchor_invalid"
  | "aborted"
  | "network_error"
  | "invalid_json"
  | "invalid_ledger_record"
  | "invalid_ledger_slot"
  | "invalid_ledger_handoff"
  | "ledger_commit_failed"
  | "ledger_bundle_failed"
  | "ledger_bundle_invalid"
  | "ledger_note_invalid"
  | "ledger_pending_timeout"
  | "invalid_allowed_sub"
  | "mandate_mismatch"
  | "invalid_mandate_use"
  | "invalid_mandate_id"
  | "mandate_not_allowed"
  | "mandate_not_found"
  | "mandate_closed"
  | "mandate_outside"
  | "mandate_use_conflict"
  | "mandate_failed"
  | "invalid_mandate_record";

export type AppClientErrorDetails = {
  /** The `error` in the API response body, for example `RETURN_URL_NOT_ALLOWED`. */
  apiError?: string;
  /** The `message` in the API response body. */
  apiMessage?: string;
  /** The `trace_id` in the API response body. */
  traceId?: string;
  /** Why the use fell outside the delegation's terms (`mandate_outside`), in the order of `MANDATE_VIOLATIONS`. */
  violations?: string[];
  /** The verifier's reason for refusing (`receipt_invalid`, `invalid_mandate_record`, `ledger_bundle_invalid` and the rest), named as the verifier's ABI names it */
  verifierReason?: string;
  /** The original exception a check or a fetch threw. */
  cause?: unknown;
};

export class AppClientError extends Error {
  readonly code: AppClientErrorCode;
  readonly status?: number;
  readonly apiError?: string;
  readonly apiMessage?: string;
  readonly traceId?: string;
  readonly violations?: string[];
  readonly verifierReason?: string;

  constructor(code: AppClientErrorCode, message: string, status?: number, details?: AppClientErrorDetails) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "AppClientError";
    this.code = code;
    this.status = status;
    if (details?.apiError !== undefined) this.apiError = details.apiError;
    if (details?.apiMessage !== undefined) this.apiMessage = details.apiMessage;
    if (details?.traceId !== undefined) this.traceId = details.traceId;
    if (details?.violations !== undefined) this.violations = details.violations;
    if (details?.verifierReason !== undefined) this.verifierReason = details.verifierReason;
  }
}
