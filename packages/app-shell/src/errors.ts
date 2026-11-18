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

export type ClavisButtonErrorCode =
  | "invalid_start_url"
  | "insecure_start_url"
  | "start_url_credentials"
  | "start_url_host_not_allowed";

/**
 * Thrown when the URL that `start` returned will not be opened.
 * `code` is for the integrating developer; the button shows a line in the viewer's language instead.
 */
export class ClavisButtonError extends Error {
  readonly code: ClavisButtonErrorCode;
  readonly host?: string;

  constructor(code: ClavisButtonErrorCode, message: string, details?: HandoffShellErrorDetails) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ClavisButtonError";
    this.code = code;
    if (details?.host !== undefined) this.host = details.host;
  }
}
