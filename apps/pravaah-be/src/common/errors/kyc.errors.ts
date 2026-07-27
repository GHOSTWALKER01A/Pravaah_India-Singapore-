/**
 * Typed, transport-agnostic KYC error taxonomy. Services return these inside a
 * {@link Result}; controllers/orchestrator decide how (or whether) to surface
 * them as HTTP exceptions. `retryable` distinguishes transient provider
 * failures (keep the check PENDING and re-poll) from terminal ones (FAILED).
 */
export enum KycErrorCode {
  PROVIDER_DOWN = 'PROVIDER_DOWN',
  PROVIDER_REJECTED = 'PROVIDER_REJECTED',
  INVALID_INPUT = 'INVALID_INPUT',
  DOC_EXPIRED = 'DOC_EXPIRED',
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  SPOOF_SUSPECTED = 'SPOOF_SUSPECTED',
  SANCTIONS_HIT = 'SANCTIONS_HIT',
  NAME_MISMATCH = 'NAME_MISMATCH',
  ALREADY_COMPLETED = 'ALREADY_COMPLETED',
  STATE_CONFLICT = 'STATE_CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
}

export class KycError {
  constructor(
    public readonly code: KycErrorCode,
    public readonly message: string,
    public readonly retryable = false,
    public readonly cause?: unknown,
  ) {}
}
