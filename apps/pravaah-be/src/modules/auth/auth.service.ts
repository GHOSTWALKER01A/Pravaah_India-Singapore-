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
import { hashIdentifier, hashIpNetwork } from '@/modules/fraud/risk-hash.util'
import { VelocityService } from '@/modules/fraud/services/velocity.service'
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
    /**
     * M6's velocity service, for credential-stuffing and ATO detection (T3, T2).
     *
     * Injected as the narrow service rather than the whole `RiskService`, deliberately.
     * Login scoring needs `AuthAttempt` recording and the stuffing counters, not the
     * five-layer engine — a device/graph/behaviour evaluation on every OTP check would add
     * five queries to the hottest unauthenticated path in the product.
     */
    private readonly velocity: VelocityService,
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

  /**
   * Verify the OTP with Twilio, provision the user, and return a session.
   *
   * ## The M6 hooks, and why they sit exactly here
   *
   * Every outcome — approved, wrong code, provider error — is recorded as an `AuthAttempt`
   * BEFORE the result is returned. That ordering is the whole credential-stuffing defence
   * (T3): a bot spraying a leaked credential dump mostly MISSES, so a system that only
   * recorded successes would be blind to the spray. Recording the failure first also means
   * the current attempt is counted in its own velocity evaluation.
   *
   * The attempt is recorded against the identifier whether or not the user exists, which is
   * why `AuthAttempt.userId` is nullable — the most interesting attempts are against
   * identifiers that were never registered.
   */
  async verifyOtp(
    request: VerifyRequest,
    /**
     * Request context for M6. Optional so existing callers compile; absent means the
     * per-network stuffing counter degrades to per-identifier only.
     */
    context: { ipAddress?: string | null } = {},
  ): Promise<VerifyData> {
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
      /**
       * A provider error is recorded too, and labelled distinctly.
       *
       * It is NOT a failed credential attempt — nobody guessed wrong — so counting it as
       * one would let a Twilio outage lock out every user by inflating their failure
       * counts. The label is what lets an analyst tell the two apart.
       */
      await this.velocity.recordAuthAttempt({
        identifier: phone,
        ipAddress: context.ipAddress,
        success: false,
        outcome: 'PROVIDER_ERROR',
      })
      throw new BadRequestException(this.providerMessage(error))
    }

    if (!approved) {
      await this.velocity.recordAuthAttempt({
        identifier: phone,
        ipAddress: context.ipAddress,
        success: false,
        outcome: 'OTP_WRONG',
      })

      /**
       * The stuffing check runs on FAILURE, and its verdict can hard-block.
       *
       * Checked after recording so this attempt counts toward the threshold. A hard block
       * (40+ failures from one /24 in ten minutes) returns the same generic message as a
       * wrong code — telling a bot it has been rate-limited tells it to rotate networks.
       */
      const stuffing = await this.velocity.loginSignals({
        identifierHash: hashIdentifier(phone),
        ipHash: context.ipAddress ? hashIpNetwork(context.ipAddress) : null,
      })

      if (stuffing.some((signal) => signal.isHard)) {
        this.logger.warn(
          `[${this.verifyOtp.name}] Refusing further attempts — credential-stuffing pattern`,
          { reasons: stuffing.map((signal) => signal.reason) },
        )
        throw new BadRequestException(
          'OTP is invalid or expired. Request a new one and use the latest code.',
        )
      }

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

    /**
     * The successful attempt, recorded and attributed.
     *
     * Successes matter as much as failures here: a stuffing run that eventually LANDS
     * shows up as a success from a network with a wall of failures behind it, and an
     * analyst reading only the failures would see the attack but miss the breach.
     *
     * Best-effort — `recordAuthAttempt` swallows its own errors — because a login must
     * never fail on an analytics write.
     */
    await this.velocity.recordAuthAttempt({
      identifier: phone,
      ipAddress: context.ipAddress,
      userId: user.id,
      success: true,
      outcome: 'OK',
    })

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
