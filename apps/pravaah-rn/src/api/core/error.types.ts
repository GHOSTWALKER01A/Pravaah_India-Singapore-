/** Normalized API error. The backend returns `{ success, message, ... }`. */
export interface ApiErrorShape {
  message?: string | { message?: string; code?: string };
  code?: string;
  status?: number;
  /** Any other fields the server put in the error body. */
  [key: string]: unknown;
}

function normalizeMessage(message: ApiErrorShape['message']): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object' && typeof message.message === 'string') {
    return message.message;
  }
  return 'Something went wrong. Please try again.';
}

export class ApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  /**
   * The rest of the error body, as the server sent it.
   *
   * Kept because some refusals are STRUCTURED, and the structure is the part the user
   * needs: when M6 stops a passport share it answers `{ message, reasons: [...] }`, and
   * the reasons ("shared with many organisations in a short time") are what makes the
   * refusal explicable. Dropping everything but `message` turned that into a bare "no".
   */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(error: ApiErrorShape) {
    super(normalizeMessage(error.message));
    this.name = 'ApiError';
    this.status = error.status;
    this.code =
      error.code ??
      (typeof error.message === 'object' ? error.message?.code : undefined);
    const { message: _message, code: _code, status: _status, ...rest } = error;
    this.details = rest;
  }

  /**
   * Plain-language reasons attached to a refusal, when the server sent any. Filtered to
   * strings so a malformed body can never put an object on screen.
   */
  get reasons(): string[] {
    const raw = this.details.reasons;
    return Array.isArray(raw)
      ? raw.filter((reason): reason is string => typeof reason === 'string')
      : [];
  }
}
