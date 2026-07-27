import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  AdminProfile,
  AdminVerifyData,
  RefreshTokenData,
  RefreshTokenRequest,
  SignInData,
  SignInRequest,
  VerifyRequest,
} from '@pravaah/schema'

import {
  activeAdminWhere,
  phoneDigits,
} from '@/common/utils/admin-identity.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { TokenService } from '@/modules/auth/token.service'
import { TwilioVerifyService } from '@/modules/auth/twilio-verify.service'

import type { AdminUser } from 'generated/prisma/client'

/**
 * Admin console auth — phone OTP via Twilio Verify, but ONLY for
 * pre-provisioned, active AdminUser rows (never auto-created). On success we
 * mint our own session JWT carrying the admin identity.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger: AppLogger

  constructor(
    private readonly twilio: TwilioVerifyService,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminAuthService.name })
  }

  /** Send/resend an admin OTP — refuses unless the phone is an active admin. */
  async sendOtp(request: SignInRequest): Promise<SignInData> {
    await this.requireActiveAdmin(request.phone, request.countryCode)
    this.ensureTwilio()

    const phone = this.formatPhone(request.phone, request.countryCode)
    try {
      await this.twilio.sendSms(phone)
    } catch (error) {
      this.logger.error(`[${this.sendOtp.name}] Admin OTP send failed`, {
        err: error,
      })
      throw new BadRequestException(this.providerMessage(error))
    }
    return {
      channel: 'sms',
      phone: request.phone,
      countryCode: request.countryCode,
    }
  }

  /** Verify an admin OTP; returns the reviewer profile + session. */
  async verifyOtp(request: VerifyRequest): Promise<AdminVerifyData> {
    const phone = this.formatPhone(request.phone, request.countryCode)
    const otp = request.otp.replace(/\D/g, '')
    this.ensureTwilio()

    let approved: boolean
    try {
      approved = await this.twilio.check(phone, otp)
    } catch (error) {
      this.logger.error(`[${this.verifyOtp.name}] Admin OTP check failed`, {
        err: error,
      })
      throw new BadRequestException(this.providerMessage(error))
    }
    if (!approved) {
      throw new BadRequestException(
        'OTP is invalid or expired. Request a new one and use the latest code.',
      )
    }

    const admin = await this.findActiveAdmin(phone)
    if (!admin) {
      throw new ForbiddenException('You are not an authorized admin')
    }

    const session = await this.tokens.issueSession({
      sub: admin.id,
      phone: admin.phone ?? phone,
      role: admin.role,
    })
    this.logger.info(`[${this.verifyOtp.name}] Admin signed in`, {
      adminId: admin.id,
      role: admin.role,
    })
    return {
      admin: this.toProfile(admin),
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    }
  }

  refreshToken(request: RefreshTokenRequest): Promise<RefreshTokenData> {
    return this.tokens.refresh(request.refreshToken)
  }

  toProfile(admin: AdminUser): AdminProfile {
    return {
      id: admin.id,
      email: admin.email,
      phone: admin.phone,
      role: admin.role,
      isActive: admin.isActive,
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async requireActiveAdmin(
    phone: string,
    countryCode: string,
  ): Promise<void> {
    const admin = await this.findActiveAdmin(
      this.formatPhone(phone, countryCode),
    )
    if (!admin) {
      // Don't reveal which admins exist — a generic 403.
      throw new ForbiddenException('You are not an authorized admin')
    }
  }

  private findActiveAdmin(phoneE164: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findFirst({
      where: activeAdminWhere({ phoneDigits: phoneDigits(phoneE164) }),
    })
  }

  private ensureTwilio(): void {
    if (!this.twilio.isEnabled()) {
      throw new ServiceUnavailableException(
        'OTP service is not configured (TWILIO_* env missing).',
      )
    }
  }

  private providerMessage(error: unknown): string {
    const e = error as { response?: { data?: { message?: string } } }
    return e?.response?.data?.message ?? 'Unable to send OTP. Please try again.'
  }

  private formatPhone(phone: string, countryCode: string): string {
    const cc = countryCode.replace(/\D/g, '')
    const local = phone.replace(/\D/g, '')
    if (!local) return cc ? `+${cc}` : ''
    if (cc && local.startsWith(cc)) return `+${local}`
    return `+${cc}${local}`
  }
}
