export type HandoffShellErrorCode =
  | "invalid_consume_url"
  | "insecure_consume_url"
  | "consume_url_credentials"
  | "consume_url_host_not_allowed";

export type HandoffShellErrorDetails = {
  /** The hostname of `consume_url` (`consume_url_host_not_allowed`). */
  host?: string;
  /** The exception `new URL()` threw (`invalid_consume_url`). */
  cause?: unknown;
};

/**
 * Thrown when the `consume_url` that `register` returned cannot be opened.
 * `code` is for the integrating developer; the overlay shows localized wording instead.
 */
export class HandoffShellError extends Error {
  readonly code: HandoffShellErrorCode;
  readonly host?: string;

  constructor(code: HandoffShellErrorCode, message: string, details?: HandoffShellErrorDetails) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "HandoffShellError";
    this.code = code;
    if (details?.host !== undefined) this.host = details.host;
  }
}
