import axios, { AxiosRequestConfig } from 'axios'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, Result } from '@/common/result/result'

const MAX_RETRIES = 2
const DEFAULT_TIMEOUT_MS = 15_000
const RETRYABLE_STATUS = new Set([502, 503, 504])

/**
 * Per-call overrides for the two knobs whose right value is endpoint-specific.
 *
 * A single global timeout cannot serve this rail: most Decentro calls answer in
 * well under a second, but the public-registry lookups sit in front of a
 * government database and are periodically far slower. Sharing one budget means
 * either failing the slow endpoints or making every fast one hang.
 */
export type HttpJsonOptions = {
  /** Response timeout for this call. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /**
   * Transient-failure retries. `0` disables retrying — correct for a slow
   * upstream, where an immediate retry adds load to the thing already
   * struggling and multiplies the caller's wait by the attempt count.
   */
  maxRetries?: number
}

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
  opts: HttpJsonOptions = {},
): Promise<Result<T>> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES
  let attempt = 0

  while (true) {
    try {
      const res = await axios.request<T>({
        ...cfg,
        // After the spread, so an explicit `cfg.timeout` still wins.
        timeout: cfg.timeout ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: { ...cfg.headers, 'x-trace-id': traceId },
      })
      return Ok(res.data)
    } catch (e: unknown) {
      const err = e as {
        response?: { status?: number; data?: unknown }
        code?: string
      }
      const status = err?.response?.status
      /**
       * Axios reports an exceeded `timeout` as ECONNABORTED, but the SAME
       * condition arrives as ETIMEDOUT once `transitional.clarifyTimeoutError`
       * is on, and a kernel-level connect timeout is always ETIMEDOUT. Matching
       * only ECONNABORTED mislabelled those as PROVIDER_DOWN — same retry
       * behaviour, but a misleading code on the check and in the logs.
       */
      const isTimeout =
        err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT'
      const transient = !status || RETRYABLE_STATUS.has(status) || isTimeout

      if (transient && attempt < maxRetries) {
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
