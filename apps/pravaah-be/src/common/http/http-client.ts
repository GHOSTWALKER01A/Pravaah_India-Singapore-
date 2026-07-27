import axios, { AxiosRequestConfig } from 'axios'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, Result } from '@/common/result/result'

const MAX_RETRIES = 2
const DEFAULT_TIMEOUT_MS = 15_000
const RETRYABLE_STATUS = new Set([502, 503, 504])

/**
 * Resilient JSON HTTP call used by all external KYC providers.
 *
 * - Retries only transient failures (network error, timeout, 5xx) with
 *   exponential backoff; never retries a 4xx (a deterministic rejection).
 * - Normalises every failure into a typed {@link KycError} so callers can
 *   branch on `retryable` instead of inspecting axios internals.
 * - Threads a trace id header for cross-service correlation.
 */
export async function httpJson<T>(
  cfg: AxiosRequestConfig,
  traceId: string,
): Promise<Result<T>> {
  let attempt = 0

  while (true) {
    try {
      const res = await axios.request<T>({
        timeout: DEFAULT_TIMEOUT_MS,
        ...cfg,
        headers: { ...cfg.headers, 'x-trace-id': traceId },
      })
      return Ok(res.data)
    } catch (e: unknown) {
      const err = e as {
        response?: { status?: number; data?: { message?: string } }
        code?: string
      }
      const status = err?.response?.status
      const isTimeout = err?.code === 'ECONNABORTED'
      const transient =
        !status || RETRYABLE_STATUS.has(status) || isTimeout

      if (transient && attempt < MAX_RETRIES) {
        attempt++
        await sleep(300 * 2 ** attempt)
        continue
      }

      if (isTimeout) {
        return Err(
          new KycError(KycErrorCode.TIMEOUT, 'Provider timeout', true, e),
        )
      }
      if (transient) {
        return Err(
          new KycError(
            KycErrorCode.PROVIDER_DOWN,
            'Provider unavailable',
            true,
            e,
          ),
        )
      }
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          err?.response?.data?.message ?? 'Provider rejected request',
          false,
          err?.response?.data,
        ),
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
