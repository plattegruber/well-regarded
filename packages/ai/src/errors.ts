/**
 * Typed errors for the AI client layer (issue #63).
 *
 * Callers branch on these classes, never on message strings:
 * - `AiRequestError` — the API request itself failed after retries were
 *   exhausted (429/5xx/overloaded) or immediately (non-retryable 4xx).
 * - `AiResponseError` — the API returned a response we could not use
 *   (no forced tool_use block, unexpected stop reason).
 * - `AiValidationError` — the model emitted tool input twice that failed
 *   zod validation (the one retry-with-feedback also missed).
 */

export class AiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** API request failed (transport / HTTP level). */
export class AiRequestError extends AiError {
  /** HTTP status, when the failure was an API error response. */
  readonly status: number | undefined;
  /** How many attempts were made (1 = failed without retrying). */
  readonly attempts: number;

  constructor(
    message: string,
    details: { status?: number; attempts: number; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.status = details.status;
    this.attempts = details.attempts;
  }
}

/** The API responded, but not with the forced tool_use block we required. */
export class AiResponseError extends AiError {
  readonly stopReason: string | null;

  constructor(message: string, details: { stopReason: string | null }) {
    super(message);
    this.stopReason = details.stopReason;
  }
}

/**
 * Structured output failed zod validation on the original call AND on the
 * single retry that fed the validation error back to the model.
 */
export class AiValidationError extends AiError {
  readonly promptName: string;
  readonly purpose: string;
  /** Human-readable summary of the final zod issues. */
  readonly issues: string;

  constructor(details: {
    promptName: string;
    purpose: string;
    issues: string;
  }) {
    super(
      `AI output for prompt "${details.promptName}" (purpose "${details.purpose}") ` +
        `failed schema validation after one retry: ${details.issues}`,
    );
    this.promptName = details.promptName;
    this.purpose = details.purpose;
    this.issues = details.issues;
  }
}
