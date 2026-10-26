import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { ENV } from '@/constants/environment.constants'

/**
 * M7 runtime policy, read from one place.
 *
 * Every value has a safe default so a fresh checkout runs the partner loop with no
 * extra configuration. The two values that change behaviour in production — the
 * private-webhook allowance and the price — are resolved defensively: the first is
 * refused outright under NODE_ENV=production, the second must parse as a
 * non-negative integer or the default is used.
 */
@Injectable()
export class PartnerConfig {
  constructor(private readonly config: ConfigService) {}

  /** Minor units of {@link billingCurrency} per billable verification. */
  pricePerVerificationMinor(): number {
    return this.intOr(
      ENV.PARTNER.PRICE_PER_VERIFICATION_MINOR,
      50,
      0,
      1_000_000,
    )
  }

  billingCurrency(): string {
    const raw = this.config.get<string>(ENV.PARTNER.BILLING_CURRENCY)
    return raw && /^[A-Z]{3}$/.test(raw) ? raw : 'SGD'
  }

  webhookTimeoutMs(): number {
    return this.intOr(ENV.PARTNER.WEBHOOK_TIMEOUT_MS, 5_000, 500, 30_000)
  }

  webhookMaxAttempts(): number {
    return this.intOr(ENV.PARTNER.WEBHOOK_MAX_ATTEMPTS, 8, 1, 20)
  }

  /**
   * Whether webhooks may target loopback / private addresses. Development only:
   * in production this is the SSRF hole the check exists to close, so the flag is
   * ignored there no matter what the environment says.
   */
  allowPrivateWebhooks(): boolean {
    if (this.isProduction()) return false
    return (
      this.config.get<string>(ENV.PARTNER.ALLOW_PRIVATE_WEBHOOKS) === 'true'
    )
  }

  holderFanoutPerHour(): number {
    return this.intOr(ENV.PARTNER.HOLDER_FANOUT_PER_HOUR, 20, 1, 1_000)
  }

  perHolderRequestsPerHour(): number {
    return this.intOr(ENV.PARTNER.PER_HOLDER_REQUESTS_PER_HOUR, 10, 1, 1_000)
  }

  isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production'
  }

  private intOr(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = this.config.get<string | number>(key)
    const parsed = typeof raw === 'number' ? raw : Number(raw)
    if (raw === undefined || raw === '' || !Number.isInteger(parsed))
      return fallback
    return Math.min(max, Math.max(min, parsed))
  }
}
