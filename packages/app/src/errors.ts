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
  | "invalid_message_digest"
  | "invalid_ui_locales"
  | "invalid_ttl"
  | "register_failed"
  | "invalid_register_response"
  | "invalid_status_args"
  | "status_failed"
  | "invalid_status"
  | "status_request_mismatch"
  | "receipt_invalid"
  | "anchor_invalid"
  | "digest_mismatch"
  | "timeout"
  | "aborted"
  | "network_error"
  | "invalid_webhook_ping"
  | "invalid_json"
  | "invalid_ledger_record"
  | "invalid_ledger_slot"
  | "invalid_ledger_handoff"
  | "ledger_commit_failed"
  | "ledger_bundle_failed"
  | "ledger_bundle_invalid"
  | "ledger_note_invalid"
  | "ledger_pending_timeout"
  | "invalid_mandate_terms"
  | "invalid_allowed_sub"
  | "mandate_terms_mismatch"
  | "mandate_mismatch"
  | "invalid_mandate_use"
  | "invalid_mandate_id"
  | "mandate_not_allowed"
  | "mandate_not_found"
  | "mandate_closed"
  | "mandate_outside"
  | "mandate_use_conflict"
  | "mandate_failed"
  | "invalid_mandate_record"
  | "invalid_on_behalf"
  | "on_behalf_mismatch"
  | "declined"
  | "unavailable"
  | "invalid_sign_in_args"
  | "state_mismatch"
  | "invalid_callback"
  | "invalid_token_response"
  | "id_token_invalid"
  | "revoke_failed"
  | "org_membership_failed"
  | "invalid_org_membership"
  | "invalid_app_user"
  | "invalid_link_confirmation"
  | "link_pending"
  | "link_mismatch"
  | "invalid_agreement"
  | "agreement_mismatch"
  | "invalid_agreement_state"
  | "agreement_state_failed"
  | "agreement_required";

export type AppClientErrorDetails = {
  /** The `error` in the API response body, for example `RETURN_URL_NOT_ALLOWED`. */
  apiError?: string;
  /** The `message` in the API response body. */
  apiMessage?: string;
  /** The `trace_id` in the API response body. */
  traceId?: string;
  /** Why the use fell outside the delegation's terms (`mandate_outside`), in the order of `MANDATE_VIOLATIONS`. */
  violations?: string[];
  /** Why `requireAgreement` refused: no agreement in force (`none`), or one given on terms that changed since (`reconsent_required`) */
  agreement?: "none" | "reconsent_required";
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
  /** For `agreement_required`: `none` or `reconsent_required` */
  readonly agreement?: "none" | "reconsent_required";

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
    if (details?.agreement !== undefined) this.agreement = details.agreement;
  }
}
