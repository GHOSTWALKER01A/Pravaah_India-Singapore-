import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  RefreshTokenData,
  RefreshTokenRequest,
  SignInData,
  SignInRequest,
  VerifyData,
  VerifyRequest,
} from '@pravaah/schema'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { TokenService } from '@/modules/auth/token.service'
import { TwilioVerifyService } from '@/modules/auth/twilio-verify.service'
import { PravaahIdService } from '@/modules/users/pravaah-id.service'

/**
 * Phone (SMS) OTP auth via Twilio Verify. Twilio sends and checks the code;
 * once approved we provision the user and mint our OWN session JWTs
 * (TokenService). No Supabase in the auth path.
 */
@Injectable()
export class AuthService {
  private readonly logger: AppLogger

  constructor(
    private readonly twilio: TwilioVerifyService,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly pravaahIds: PravaahIdService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AuthService.name })
  }

  /** Send (or resend) a login OTP over SMS. Signup and login are the same flow. */
  async signInWithOtp(request: SignInRequest): Promise<SignInData> {
    const phone = this.formatPhone(request.phone, request.countryCode)
    this.ensureTwilio()
    try {
      await this.twilio.sendSms(phone)
    } catch (error) {
      this.logger.error(`[${this.signInWithOtp.name}] OTP send failed`, {
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

  /** Verify the OTP with Twilio, provision the user, and return a session. */
  async verifyOtp(request: VerifyRequest): Promise<VerifyData> {
    const phone = this.formatPhone(request.phone, request.countryCode)
    const otp = request.otp.replace(/\D/g, '')
    this.ensureTwilio()

    let approved: boolean
    try {
      approved = await this.twilio.check(phone, otp)
    } catch (error) {
      this.logger.error(`[${this.verifyOtp.name}] OTP check failed`, {
        err: error,
      })
      throw new BadRequestException(this.providerMessage(error))
    }
    if (!approved) {
      throw new BadRequestException(
        'OTP is invalid or expired. Request a new one and use the latest code.',
      )
    }

    // Provision (or fetch) the user keyed by their verified phone number. A new
    // user is minted a Pravaah ID in this same write; an existing one already
    // carries theirs, so `ensureFor` is a no-op read-free call below.
    const user = await this.prisma.user.upsert({
      where: { phone },
      create: { phone, pravaahId: this.pravaahIds.generate() },
      update: {},
      select: { id: true, kycStatus: true, pravaahId: true },
    })

    // Repairs rows that predate the column (or were seeded without one), so no
    // signed-in user is ever without the identity the app is about to show.
    const pravaahId = await this.pravaahIds.ensureFor(user.id, user.pravaahId)

    const session = await this.tokens.issueSession({
      sub: user.id,
      phone,
      role: 'user',
    })

    return {
      userId: user.id,
      pravaahId,
      channel: 'sms',
      phone: request.phone,
      countryCode: request.countryCode,
      kycStatus: user.kycStatus,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    }
  }

  refreshToken(request: RefreshTokenRequest): Promise<RefreshTokenData> {
    return this.tokens.refresh(request.refreshToken)
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
