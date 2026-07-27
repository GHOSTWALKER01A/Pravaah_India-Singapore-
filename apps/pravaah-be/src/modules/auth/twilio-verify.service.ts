import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import axios, { isAxiosError } from 'axios'

import { ENV } from '@/constants/environment.constants'

/**
 * Twilio Verify — sends AND checks the phone OTP. Twilio owns the code
 * lifecycle (generation, SMS delivery, expiry, attempt limits), so the app
 * never sees or stores the code. Equivalent to:
 *
 *   POST https://verify.twilio.com/v2/Services/{SID}/Verifications
 *        To=+91… Channel=sms                       (send)
 *   POST https://verify.twilio.com/v2/Services/{SID}/VerificationCheck
 *        To=+91… Code=123456                        (check)
 */
@Injectable()
export class TwilioVerifyService {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: TwilioVerifyService.name })
  }

  isEnabled(): boolean {
    // The bypass number needs no Twilio config, so the auth flows must not be
    // gated off when only the bypass is set up (e.g. local dev without Twilio).
    if (this.bypassPhone()) return true
    return Boolean(
      this.config.get<string>(ENV.TWILIO.ACCOUNT_SID) &&
        this.config.get<string>(ENV.TWILIO.AUTH_TOKEN) &&
        this.config.get<string>(ENV.TWILIO.VERIFY_SERVICE_SID),
    )
  }

  /** Send an OTP over SMS to a full E.164 number (e.g. +917389721118). */
  async sendSms(toE164: string): Promise<void> {
    if (this.isBypass(toE164)) {
      this.logger.warn(`[${this.sendSms.name}] DEV bypass — no SMS sent`, {
        to: toE164,
      })
      return
    }
    const res = await axios.post(
      `${this.baseUrl()}/Verifications`,
      new URLSearchParams({ To: toE164, Channel: 'sms' }),
      { auth: this.auth(), timeout: 15_000 },
    )
    this.logger.info(`[${this.sendSms.name}] Verification sent`, {
      to: toE164,
      status: res.data?.status,
    })
  }

  /** Check a code against the pending verification. Returns true iff approved. */
  async check(toE164: string, code: string): Promise<boolean> {
    if (this.isBypass(toE164)) {
      const ok = code.replace(/\D/g, '') === this.bypassOtp()
      this.logger.warn(`[${this.check.name}] DEV bypass — code checked locally`, {
        to: toE164,
        approved: ok,
      })
      return ok
    }
    try {
      const res = await axios.post(
        `${this.baseUrl()}/VerificationCheck`,
        new URLSearchParams({ To: toE164, Code: code }),
        { auth: this.auth(), timeout: 15_000 },
      )
      return res.data?.status === 'approved'
    } catch (error) {
      // 404 = no pending verification (expired / already consumed / too many
      // attempts). Treat as a failed check rather than a server error.
      if (isAxiosError(error) && error.response?.status === 404) {
        return false
      }
      throw error
    }
  }

  /** Digits-only DEV bypass phone, or '' if not configured. */
  private bypassPhone(): string {
    return (
      this.config.get<string>(ENV.AUTH_DEV.BYPASS_PHONE)?.replace(/\D/g, '') ??
      ''
    )
  }

  /** DEV bypass OTP (digits only); defaults to 123456 when a bypass phone is set. */
  private bypassOtp(): string {
    return (
      this.config.get<string>(ENV.AUTH_DEV.BYPASS_OTP)?.replace(/\D/g, '') ||
      '123456'
    )
  }

  /** True iff `toE164` is the configured DEV bypass number (format-tolerant). */
  private isBypass(toE164: string): boolean {
    const bypass = this.bypassPhone()
    return bypass !== '' && toE164.replace(/\D/g, '') === bypass
  }

  private baseUrl(): string {
    const sid = this.config.getOrThrow<string>(ENV.TWILIO.VERIFY_SERVICE_SID)
    return `https://verify.twilio.com/v2/Services/${sid}`
  }

  private auth(): { username: string; password: string } {
    return {
      username: this.config.getOrThrow<string>(ENV.TWILIO.ACCOUNT_SID),
      password: this.config.getOrThrow<string>(ENV.TWILIO.AUTH_TOKEN),
    }
  }
}
