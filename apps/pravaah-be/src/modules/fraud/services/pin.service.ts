import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
import { compare, hash } from 'bcrypt'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { PIN_POLICY } from '@/modules/fraud/fraud.config'
import { isWeakPin } from '@/modules/fraud/fraud.state'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'

import { ActorType, type UserCredential } from 'generated/prisma/client'

/** What the app needs to know to decide which factor to ask for. */
export interface PinStatus {
  enrolled: boolean
  /** True while a lockout is active. The app must not offer the PIN field. */
  locked: boolean
  lockedUntil: Date | null
  /** Guesses left before a lockout. `null` when not enrolled. */
  attemptsRemaining: number | null
  biometricEnrolled: boolean
  biometricLevel: string | null
}

/**
 * The transaction PIN — Pravaah's own knowledge factor.
 *
 * ## Why a PIN at all, when there is already an SMS OTP
 *
 * Because an OTP delivered to the same handset that is making the payment is not a second
 * factor. One compromise — a stolen unlocked phone, or malware with SMS-read permission —
 * defeats both halves at once. This is the standing criticism of SMS as a payment factor and
 * it is why NPCI put the UPI PIN in a bank-validated secure component instead.
 *
 * A PIN is knowledge the thief does not have. Holding the phone stops being sufficient.
 *
 * ## What this is NOT, stated because confusing the two is a phishing vector
 *
 * Not the UPI PIN. That is registered against the user's bank account, entered in NPCI's
 * Common Library (a component only a certified PSP may embed), and validated by the issuing
 * bank's HSM — Pravaah cannot and must not see it. THIS PIN authorises an instruction against
 * the Pravaah wallet. Every string the user reads says so.
 *
 * ## The reset path is the whole security question
 *
 * Every PIN system needs "I forgot it", and that path is almost always an SMS OTP — which
 * hands the stolen-phone attacker a way to simply RESET the PIN and pay. The weakness the PIN
 * was meant to close, reopened one screen back.
 *
 * Banks solve it with a possession factor (debit card number + expiry). Pravaah has no card,
 * so {@link reset} instead RESTARTS THE DEVICE COOLING-OFF: for 24 hours after a reset, every
 * high-value transfer still faces the risk ladder's device signals and can be held for an
 * analyst. "Reset and drain" becomes "reset, then wait while somebody watches". That trade —
 * a real user waits a day for large transfers after forgetting their PIN — is the price of the
 * reset path not being a bypass.
 *
 * ## Why the attempt counter lives here and not on the client
 *
 * A six-digit PIN is a million candidates; four is ten thousand. A client-side counter is one
 * an attacker reinstalls their way out of, which makes the PIN a guessing game they win. The
 * counter, the lockout, and the comparison are all server-side, and the client is told only
 * how many attempts remain.
 */
@Injectable()
export class PinService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DeviceTrustService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PinService.name })
  }

  // ── status ────────────────────────────────────────────────────────────────
  /**
   * What factors this user has, for the app to branch on.
   *
   * Deliberately returns `attemptsRemaining` rather than the raw attempt count: the client
   * renders "2 attempts left", and computing that from a raw count would need the cap too —
   * two fields where one suffices, and a subtraction for a client to get wrong.
   */
  async status(userId: string): Promise<PinStatus> {
    const credential = await this.prisma.userCredential.findUnique({
      where: { userId },
      select: {
        pinHash: true,
        pinAttempts: true,
        pinLockedUntil: true,
        biometricEnrolledAt: true,
        biometricLevel: true,
      },
    })

    const enrolled = Boolean(credential?.pinHash)
    const lockedUntil = credential?.pinLockedUntil ?? null
    const locked = lockedUntil !== null && lockedUntil > new Date()

    return {
      enrolled,
      locked,
      lockedUntil: locked ? lockedUntil : null,
      attemptsRemaining: enrolled
        ? Math.max(0, PIN_POLICY.MAX_ATTEMPTS - (credential?.pinAttempts ?? 0))
        : null,
      biometricEnrolled: Boolean(credential?.biometricEnrolledAt),
      biometricLevel: credential?.biometricLevel ?? null,
    }
  }

  /** Whether a PIN can be demanded of this user right now. */
  async canUsePin(userId: string): Promise<boolean> {
    const status = await this.status(userId)
    return status.enrolled && !status.locked
  }

  // ── enrolment ─────────────────────────────────────────────────────────────
  /**
   * Set the PIN for the first time.
   *
   * ## Why this refuses to run on an unbound device
   *
   * The PIN is the knowledge half of a two-factor pair whose other half is the bound device.
   * Enrolling one from an unrecognised device would let an attacker holding only a session
   * token establish the very factor that is supposed to prove they are not doing that — they
   * would set a PIN, and then satisfy every future challenge with it.
   *
   * This mirrors UPI exactly: you cannot register a UPI PIN until device binding has proved
   * the SIM is in the handset. The SMS OTP that bound the device is what earns the right to
   * set a PIN, which is why the enrolment order is OTP → biometric → PIN and not any other.
   */
  async enrol(params: {
    userId: string
    pin: string
    clientDeviceId?: string | null
    ipAddress?: string | null
  }): Promise<PinStatus> {
    /**
     * AUTHORISATION BEFORE CONTENT. The device gate runs before the strength check.
     *
     * The order was the other way round, and a live probe from an unbound device showed why that
     * is wrong: it answered "that PIN is too easy to guess" to a caller it was about to refuse
     * anyway. The weak-PIN rule list is a detector specification, and that response turns this
     * endpoint into an oracle for it — anybody with a session and no bound device can enumerate
     * which patterns survive, at leisure, and learn nothing about their own account in the
     * process.
     *
     * Refusing on the device first means an unauthorised caller learns exactly one thing: that
     * they are unauthorised.
     */
    await this.assertDeviceBound(params.userId, params.clientDeviceId)

    this.assertWellFormed(params.pin)

    const existing = await this.prisma.userCredential.findUnique({
      where: { userId: params.userId },
      select: { pinHash: true },
    })
    if (existing?.pinHash) {
      /**
       * A 409 rather than silently overwriting.
       *
       * An enrol call that quietly replaced an existing PIN would be a PIN-change endpoint
       * with no authentication on it — exactly the bypass `change` exists to prevent.
       */
      throw new ConflictException(
        'A PIN is already set on this account. Change it instead.',
      )
    }

    const now = new Date()
    await this.prisma.userCredential.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        pinHash: await hash(params.pin, PIN_POLICY.BCRYPT_ROUNDS),
        pinSetAt: now,
        pinUpdatedAt: now,
      },
      update: {
        pinHash: await hash(params.pin, PIN_POLICY.BCRYPT_ROUNDS),
        pinSetAt: now,
        pinUpdatedAt: now,
        pinAttempts: 0,
        pinLockedUntil: null,
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: params.userId,
      action: 'pin.enrolled',
      entity: 'UserCredential',
      entityId: params.userId,
      ipAddress: params.ipAddress ?? null,
    })

    this.logger.info(`[${this.enrol.name}] Transaction PIN enrolled`, {
      userId: params.userId,
    })

    return this.status(params.userId)
  }

  /**
   * Record that the user enrolled biometrics on a device.
   *
   * Stored as a CLAIM, never as proof. The biometric check happens on the handset, so this
   * column says "the OS told the app it has a strong biometric" and nothing more —
   * `BIOMETRIC_STRONG` reported from a rooted device is worth exactly what the device's
   * integrity signal says it is. It is here so the console can see whether an account has a
   * real second factor and so the app can be told what it enrolled last time.
   */
  async recordBiometric(params: {
    userId: string
    level: string
  }): Promise<PinStatus> {
    await this.prisma.userCredential.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        biometricEnrolledAt: new Date(),
        biometricLevel: params.level,
      },
      update: {
        biometricEnrolledAt: new Date(),
        biometricLevel: params.level,
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: params.userId,
      action: 'biometric.enrolled',
      entity: 'UserCredential',
      entityId: params.userId,
      metadata: { level: params.level },
    })

    return this.status(params.userId)
  }

  // ── verification ──────────────────────────────────────────────────────────
  /**
   * Check a PIN. THE control.
   *
   * ## Why a wrong PIN and an unenrolled account give the same error
   *
   * Both answer "that did not work" without saying which. Distinguishing them would let
   * somebody holding a stolen session token enumerate which accounts have a PIN — and an
   * account without one falls back to the OTP factor, so knowing that is knowing which attack
   * to run.
   *
   * ## Why the attempt increment is not in a transaction with the compare
   *
   * bcrypt takes ~100ms by design. Holding a row lock across it would serialise every
   * concurrent PIN check in the system on one user's hash computation. The increment is a
   * separate atomic statement afterwards; a lost increment under extreme concurrency costs one
   * extra guess out of five, which is a far better trade than a lock held for a tenth of a
   * second on the payment path.
   */
  async verify(params: {
    userId: string
    pin: string
    ipAddress?: string | null
  }): Promise<{ ok: true }> {
    const credential = await this.prisma.userCredential.findUnique({
      where: { userId: params.userId },
      select: { pinHash: true, pinAttempts: true, pinLockedUntil: true },
    })

    if (!credential?.pinHash) {
      throw new BadRequestException('No PIN is set on this account.')
    }

    if (credential.pinLockedUntil && credential.pinLockedUntil > new Date()) {
      throw new ForbiddenException(
        'Your PIN is locked after too many incorrect attempts. Reset it to continue.',
      )
    }

    const correct = await compare(params.pin, credential.pinHash)

    if (!correct) {
      const attempts = credential.pinAttempts + 1
      const willLock = attempts >= PIN_POLICY.MAX_ATTEMPTS

      await this.prisma.userCredential.update({
        where: { userId: params.userId },
        data: {
          pinAttempts: attempts,
          pinLockedUntil: willLock
            ? new Date(Date.now() + PIN_POLICY.LOCKOUT_MS)
            : null,
        },
      })

      if (willLock) {
        await this.audit.log({
          actorType: ActorType.SYSTEM,
          actorId: params.userId,
          action: 'pin.locked',
          entity: 'UserCredential',
          entityId: params.userId,
          metadata: { attempts },
          ipAddress: params.ipAddress ?? null,
        })
        this.logger.warn(`[${this.verify.name}] PIN locked out`, {
          userId: params.userId,
          attempts,
        })
        throw new ForbiddenException(
          'Your PIN is now locked after too many incorrect attempts. Reset it to continue.',
        )
      }

      const remaining = PIN_POLICY.MAX_ATTEMPTS - attempts
      throw new BadRequestException(
        `That PIN is not correct. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`,
      )
    }

    /**
     * Reset the counter on success, but only if it is non-zero.
     *
     * A conditional `updateMany` rather than an unconditional write, so the overwhelmingly
     * common case — a correct PIN on a clean counter — costs no write at all. Every transfer
     * goes through here, and a needless UPDATE per payment on a 330ms round trip is latency
     * spent for nothing.
     */
    if (credential.pinAttempts > 0) {
      await this.prisma.userCredential.updateMany({
        where: { userId: params.userId, pinAttempts: { gt: 0 } },
        data: { pinAttempts: 0, pinLockedUntil: null },
      })
    }

    return { ok: true }
  }

  // ── change ────────────────────────────────────────────────────────────────
  /**
   * Change the PIN.
   *
   * The CALLER is responsible for having proved the user first — biometric, or a passed
   * step-up. This method deliberately does not accept "proof" as a parameter, because a
   * boolean flag on the wire is not proof of anything: the controller establishes it from a
   * verified challenge or an attested biometric assertion and only then calls this.
   *
   * The old PIN is NOT required. That is the user's stated design and it is defensible: a
   * biometric is a stronger factor than the PIN it is replacing, so demanding both would add
   * friction without adding assurance. Somebody who can pass the biometric can already
   * authorise a payment.
   */
  async change(params: {
    userId: string
    newPin: string
    ipAddress?: string | null
  }): Promise<PinStatus> {
    this.assertWellFormed(params.newPin)

    const credential = await this.prisma.userCredential.findUnique({
      where: { userId: params.userId },
      select: { pinHash: true },
    })
    if (!credential?.pinHash) {
      throw new BadRequestException(
        'No PIN is set on this account. Set one instead of changing it.',
      )
    }

    /**
     * Refuse a change that is a no-op.
     *
     * Not cosmetic: a user who "changed" their PIN to the same digits believes they have
     * rotated a compromised secret and has not. Telling them is the whole point.
     */
    if (await compare(params.newPin, credential.pinHash)) {
      throw new BadRequestException(
        'That is the PIN you already have. Choose a different one.',
      )
    }

    await this.prisma.userCredential.update({
      where: { userId: params.userId },
      data: {
        pinHash: await hash(params.newPin, PIN_POLICY.BCRYPT_ROUNDS),
        pinUpdatedAt: new Date(),
        pinAttempts: 0,
        pinLockedUntil: null,
      },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: params.userId,
      action: 'pin.changed',
      entity: 'UserCredential',
      entityId: params.userId,
      ipAddress: params.ipAddress ?? null,
    })

    this.logger.warn(`[${this.change.name}] Transaction PIN changed`, {
      userId: params.userId,
    })

    return this.status(params.userId)
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  /**
   * Reset a forgotten or locked PIN, and pay for it with a cooling-off.
   *
   * ## The reset trap, and how this closes it
   *
   * The caller has proved the user with an SMS OTP. On its own that would make the PIN
   * pointless against the threat it exists for: somebody holding the unlocked phone reads the
   * SMS, resets the PIN, and pays. The knowledge factor evaporates.
   *
   * So a reset RESTARTS THE DEVICE COOLING-OFF on every one of the user's devices. For the
   * next 24 hours the risk ladder sees `DEVICE_NEW` on their actions, which means high-value
   * transfers are challenged or held for an analyst. The attacker's "reset and drain" becomes
   * "reset, then wait a day while somebody reviews it".
   *
   * The cost to a real user is honest and bounded: forget your PIN, and large transfers need
   * extra confirmation for a day. That is the price of the reset not being a back door, and it
   * is the same shape as a bank re-issuing a card.
   */
  async reset(params: {
    userId: string
    newPin: string
    ipAddress?: string | null
  }): Promise<PinStatus> {
    this.assertWellFormed(params.newPin)

    await this.prisma.userCredential.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        pinHash: await hash(params.newPin, PIN_POLICY.BCRYPT_ROUNDS),
        pinSetAt: new Date(),
        pinUpdatedAt: new Date(),
      },
      update: {
        pinHash: await hash(params.newPin, PIN_POLICY.BCRYPT_ROUNDS),
        pinUpdatedAt: new Date(),
        pinAttempts: 0,
        pinLockedUntil: null,
      },
    })

    /**
     * The cooling-off restart. The load-bearing half of this method.
     *
     * Applied to EVERY active device, not just the one that reset. An attacker who reset the
     * PIN from a device they had already bound would otherwise simply use a different one.
     */
    const cooled = await this.devices.restartCoolingOff(params.userId)

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: params.userId,
      action: 'pin.reset',
      entity: 'UserCredential',
      entityId: params.userId,
      metadata: { devicesCooledOff: cooled },
      ipAddress: params.ipAddress ?? null,
    })

    this.logger.warn(
      `[${this.reset.name}] PIN reset — cooling-off restarted on ${cooled} device(s)`,
      { userId: params.userId },
    )

    return this.status(params.userId)
  }

  // ── guards ────────────────────────────────────────────────────────────────
  /**
   * Reject a PIN that is not worth having.
   *
   * A 4-digit PIN is ten thousand candidates and users reach for `1234`, `0000` and birth
   * years. The lockout bounds online guessing, but it does nothing about somebody who watched
   * the user type — and a trivially guessable PIN is the difference between a shoulder-surf
   * being a full compromise and being a wasted glance.
   *
   * Refusing weak PINs at enrolment is the only place this can be done: once it is a bcrypt
   * hash, nobody can tell whether it was `1234`.
   */
  private assertWellFormed(pin: string): void {
    if (!new RegExp(`^\\d{${PIN_POLICY.LENGTH}}$`).test(pin)) {
      throw new BadRequestException(
        `Your PIN must be exactly ${PIN_POLICY.LENGTH} digits.`,
      )
    }
    if (isWeakPin(pin)) {
      throw new BadRequestException(
        'That PIN is too easy to guess. Avoid repeated digits, runs like 1234, and years.',
      )
    }
  }

  /**
   * Refuse to enrol a PIN from a device that is not bound.
   *
   * See the note on {@link enrol} — the PIN is one half of a pair whose other half is the
   * device, and letting an unbound device establish the PIN would collapse both halves into
   * whatever an attacker with a session token already has.
   */
  private async assertDeviceBound(
    userId: string,
    clientDeviceId?: string | null,
  ): Promise<void> {
    if (!clientDeviceId) {
      throw new ForbiddenException('Register this device before setting a PIN.')
    }

    const device = await this.devices.resolve(userId, clientDeviceId)
    if (!device || device.status !== 'ACTIVE') {
      throw new ForbiddenException('Register this device before setting a PIN.')
    }
  }
}

/** Re-exported so callers can name the row type without importing Prisma directly. */
export type { UserCredential }
