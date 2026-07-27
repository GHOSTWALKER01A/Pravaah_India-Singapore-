/** Normalized API error. The backend returns `{ success, message, ... }`. */
export interface ApiErrorShape {
  message?: string | { message?: string; code?: string };
  code?: string;
  status?: number;
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

  constructor(error: ApiErrorShape) {
    super(normalizeMessage(error.message));
    this.name = 'ApiError';
    this.status = error.status;
    this.code =
      error.code ??
      (typeof error.message === 'object' ? error.message?.code : undefined);
  }
}
