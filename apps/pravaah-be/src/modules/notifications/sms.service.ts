import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import axios from 'axios'

import { ENV } from '@/constants/environment.constants'

// MSG91 Flow API (same provider oscode uses). CONFIRM the template variable
// name (`otp` here) against your MSG91 OTP flow template.
const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow/'

/**
 * SMS sender via MSG91. Delivers phone OTPs from the Supabase Send SMS Hook.
 * We send the OTP Supabase generated (transactional flow with an `otp`
 * variable) — MSG91 is NOT asked to generate its own code. Disabled (no-throw)
 * when MSG91 env is absent.
 */
@Injectable()
export class SmsService {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: SmsService.name })
  }

  isEnabled(): boolean {
    return Boolean(
      this.config.get<string>(ENV.MSG91.AUTH_KEY) &&
        this.config.get<string>(ENV.MSG91.OTP_TEMPLATE_ID),
    )
  }

  /** `phone` must be full international digits without '+', e.g. 919876543210. */
  async sendOtp(phone: string, otp: string): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('SMS channel is not configured (MSG91_* env missing)')
    }
    const mobiles = phone.replace(/\D/g, '')
    const res = await axios.post(
      MSG91_FLOW_URL,
      {
        template_id: this.config.getOrThrow<string>(ENV.MSG91.OTP_TEMPLATE_ID),
        sender: this.config.get<string>(ENV.MSG91.SENDER_ID),
        recipients: [{ mobiles, otp }],
      },
      {
        headers: {
          authkey: this.config.getOrThrow<string>(ENV.MSG91.AUTH_KEY),
          'content-type': 'application/json',
        },
        timeout: 15_000,
      },
    )
    this.logger.info(`[${this.sendOtp.name}] SMS OTP dispatched`, {
      mobiles,
      status: res.status,
    })
  }

  /** True when the decision-SMS flow template is configured. */
  isDecisionEnabled(): boolean {
    return Boolean(
      this.config.get<string>(ENV.MSG91.AUTH_KEY) &&
        this.config.get<string>(ENV.MSG91.DECISION_TEMPLATE_ID),
    )
  }

  /**
   * SMS the user their KYC decision. Unlike {@link sendOtp} this is best-effort
   * and NEVER throws — a delivery failure is logged and swallowed so it cannot
   * roll back the reviewer's decision. Uses a dedicated flow template with a
   * `status` variable (CONFIRM the variable name against your MSG91 template).
   */
  async sendKycDecision(
    phone: string,
    decision: 'APPROVED' | 'REJECTED' | 'INFO_REQUESTED',
  ): Promise<{ sent: boolean }> {
    if (!this.isDecisionEnabled()) {
      this.logger.warn(
        `[${this.sendKycDecision.name}] MSG91 decision template not configured — skipping SMS`,
        { decision },
      )
      return { sent: false }
    }
    const status =
      decision === 'APPROVED'
        ? 'approved'
        : decision === 'REJECTED'
          ? 'declined'
          : 'needs more information'
    try {
      const mobiles = phone.replace(/\D/g, '')
      const res = await axios.post(
        MSG91_FLOW_URL,
        {
          template_id: this.config.getOrThrow<string>(
            ENV.MSG91.DECISION_TEMPLATE_ID,
          ),
          sender: this.config.get<string>(ENV.MSG91.SENDER_ID),
          recipients: [{ mobiles, status }],
        },
        {
          headers: {
            authkey: this.config.getOrThrow<string>(ENV.MSG91.AUTH_KEY),
            'content-type': 'application/json',
          },
          timeout: 15_000,
        },
      )
      this.logger.info(`[${this.sendKycDecision.name}] Decision SMS dispatched`, {
        mobiles,
        status: res.status,
      })
      return { sent: true }
    } catch (error) {
      this.logger.error(
        `[${this.sendKycDecision.name}] Failed to send decision SMS`,
        { err: error },
      )
      return { sent: false }
    }
  }
}
