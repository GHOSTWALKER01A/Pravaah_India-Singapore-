import { KycError } from '@/common/errors/kyc.errors'

/**
 * Discriminated-union result envelope. Keeps provider/service failures out of
 * the throw path so orchestration can branch on `retryable` deterministically.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: KycError }

export const Ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const Err = (error: KycError): Result<never> => ({ ok: false, error })
