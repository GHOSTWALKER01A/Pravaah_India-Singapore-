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
        response?: { status?: number; data?: unknown }
        code?: string
      }
      const status = err?.response?.status
      const isTimeout = err?.code === 'ECONNABORTED'
      const transient = !status || RETRYABLE_STATUS.has(status) || isTimeout

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
      /**
       * A non-transient HTTP failure (4xx) is the provider refusing to PROCESS
       * our request — bad path, bad credentials, a product the account lacks,
       * a field it did not like. It is NOT a verdict on the user's document;
       * verdicts arrive with HTTP 200 and are classified by the provider class
       * from the response body. Mapping this to PROVIDER_REJECTED is what made
       * a wrong endpoint path read as "your PAN is invalid".
       */
      return Err(
        new KycError(
          KycErrorCode.INTEGRATION_ERROR,
          providerMessage(err?.response?.data) ??
            `Provider rejected request (HTTP ${status ?? 'unknown'})`,
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

/**
 * Pull the most useful human-readable line out of a provider error body.
 * Vendors nest it inconsistently (`message`, `error.message`, `data.message`)
 * and a WAF/edge rejection may return HTML with no message at all — in which
 * case we return undefined so the caller can fall back to the status code.
 * Silently reporting a bare 403 as "Provider rejected request" hid a redirect
 * URL that Decentro's edge refused.
 */
function providerMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as Record<string, unknown>
  const candidates = [
    b.message,
    (b.error as Record<string, unknown> | undefined)?.message,
    (b.data as Record<string, unknown> | undefined)?.message,
  ]
  return candidates.find(
    (c): c is string => typeof c === 'string' && c.length > 0,
  )
}
