/** API may return `message` as a string or a nested object (NestJS shape). */
function normalizeMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (
    message &&
    typeof message === 'object' &&
    'message' in message &&
    typeof (message as { message: unknown }).message === 'string'
  ) {
    return (message as { message: string }).message;
  }
  return 'Something went wrong';
}

function normalizeCode(error: APIErrorResponse): string | undefined {
  const nested = error.message;
  if (
    nested &&
    typeof nested === 'object' &&
    typeof (nested as { code?: unknown }).code === 'string'
  ) {
    return (nested as { code: string }).code;
  }
  return error.code;
}

export interface APIErrorResponse {
  message?:
    | string
    | { message?: string; error?: string; statusCode?: number; code?: string };
  code?: string;
  status?: number;
  details?: Record<string, unknown>;
}

export class APIError extends Error {
  public readonly code?: string;
  public readonly status?: number;
  public readonly details?: Record<string, unknown>;

  constructor(error: APIErrorResponse) {
    super(normalizeMessage(error.message));
    this.name = 'APIError';
    this.code = normalizeCode(error);
    this.status = error.status;
    this.details = error.details;
  }
}
