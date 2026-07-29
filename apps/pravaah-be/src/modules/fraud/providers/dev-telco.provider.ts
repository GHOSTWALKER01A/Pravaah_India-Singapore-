import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { verifyHmacWebhook } from '@/common/http/webhook-signature.util'
import { ENV } from '@/constants/environment.constants'

import type {
  SimVerification,
  TelcoProvider,
} from '@/modules/fraud/providers/telco.provider'

/**
 * The development telco — deterministic, offline, and CI-safe.
 *
 * ## What it actually does
 *
 * It answers `verifySim` from the hash it is given, with one scripted exception
 * (`FRAUD_SIM_SWAP_HASH`) that makes the SIM-swap demo triggerable on demand. It is
 * deliberately NOT a random or stateful mock: a fraud control whose behaviour
 * varies between runs cannot be demonstrated, and an in-memory map of "swapped
 * numbers" loses every swap on restart — which in this module means a device
 * silently returning to `ACTIVE` because the provider forgot.
 *
 * ## The comparison it can and cannot make
 *
 * A real carrier holds the authoritative current serial and compares against it.
 * This provider holds nothing, so it cannot independently confirm a serial — it can
 * only report "available, nothing contradicts this". That is honest and it is
 * enough, because the actual swap DETECTION in M6 does not depend on the carrier at
 * all: `DeviceTrustService` compares the presented serial against the one WE
 * anchored at bind time, and that comparison is real. The carrier is corroboration,
 * not the control, which is exactly why the control still works with a stub behind
 * it.
 */
@Injectable()
export class DevTelcoProvider implements TelcoProvider {
  readonly name = 'dev-telco'

  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DevTelcoProvider.name })
  }

  /** Always available — that is the point of a dev provider. */
  isConfigured(): boolean {
    return true
  }

  verifySim(
    mobileHash: string,
    simSerialHash: string,
  ): Promise<SimVerification> {
    /**
     * The scripted swap.
     *
     * Set `FRAUD_SIM_SWAP_HASH` to a device's stored `simSerialHash` (or to the
     * literal `*`) and this provider reports a re-issue, driving the full
     * `SUSPECTED_SWAP` → cooling-off → step-up path live. It exists so the nastiest
     * case in the module is demonstrable on demand rather than only in production —
     * the same reasoning behind M4's `PAYMENTS_SIM_FORCE_OUTCOME`.
     */
    const scripted = this.config.get<string>(ENV.FRAUD.SIM_SWAP_HASH)?.trim()

    if (scripted && (scripted === '*' || scripted === simSerialHash)) {
      this.logger.warn(
        `[${this.verifySim.name}] Scripted SIM swap reported for a device`,
        { mobileHash: mobileHash.slice(0, 8) },
      )
      return Promise.resolve({
        matched: false,
        available: true,
        lastChangedAt: new Date(),
        detail: 'Scripted swap (FRAUD_SIM_SWAP_HASH)',
      })
    }

    /**
     * Otherwise: available, and nothing contradicts the presented serial.
     *
     * `matched: true` here means "the carrier raises no objection", NOT "we
     * independently confirmed it". The real check is the stored-anchor comparison in
     * `DeviceTrustService`, which this cannot and does not replace.
     */
    return Promise.resolve({
      matched: true,
      available: true,
      detail: 'Development provider — no carrier record consulted',
    })
  }

  /**
   * Verify a SIM-change callback.
   *
   * A REAL HMAC check over the raw bytes, even in development, using the shared
   * `verifyHmacWebhook` so the signing scheme lives in one place. A dev provider
   * that returned `true` unconditionally would mean the signature path is never
   * exercised until production — and a webhook that can flip a device into
   * `SUSPECTED_SWAP` is an authenticated endpoint by any reasonable reading, since
   * an unauthenticated one lets anybody freeze anybody's payments.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean {
    const secret = this.webhookSecret()
    const result = verifyHmacWebhook({
      signature: headers['x-pravaah-signature'] ?? headers['x-telco-signature'],
      timestamp: headers['x-pravaah-timestamp'] ?? headers['x-telco-timestamp'],
      rawBody,
      secret,
    })

    if (!result.ok) {
      this.logger.warn(
        `[${this.verifyWebhook.name}] Rejected a telco callback`,
        { reason: result.reason },
      )
    }
    return result.ok
  }

  /**
   * The callback signing secret.
   *
   * Falls back to `FIELD_ENCRYPTION_KEY` with a warning rather than to a constant,
   * so a dev environment is never silently accepting unsigned callbacks. Absent
   * both, verification cannot succeed — which fails CLOSED: an unverifiable SIM
   * change is ignored rather than trusted.
   */
  private webhookSecret(): string {
    const explicit = this.config
      .get<string>(ENV.FRAUD.TELCO_WEBHOOK_SECRET)
      ?.trim()
    if (explicit) return explicit

    const fallback = this.config
      .get<string>(ENV.CRYPTO.FIELD_ENCRYPTION_KEY)
      ?.trim()
    if (fallback) {
      this.logger.warn(
        `[${this.webhookSecret.name}] TELCO_WEBHOOK_SECRET is unset — falling back to FIELD_ENCRYPTION_KEY`,
      )
      return fallback
    }

    this.logger.error(
      `[${this.webhookSecret.name}] No telco webhook secret configured — every SIM-change callback will be refused`,
    )
    return ''
  }
}
