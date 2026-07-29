import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { TwilioVerifyService } from '@/modules/auth/twilio-verify.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { STEP_UP } from '@/modules/fraud/fraud.config'
import { isStepUpRedeemable } from '@/modules/fraud/fraud.state'
import { hashesEqual } from '@/modules/fraud/risk-hash.util'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { PinService } from '@/modules/fraud/services/pin.service'
import { VelocityService } from '@/modules/fraud/services/velocity.service'

import {
  ActorType,
  StepUpMethod,
  StepUpPurpose,
  StepUpStatus,
  type StepUpChallenge,
} from 'generated/prisma/client'

/**
 * The marker stored in `challengeHash` when the code lives at the provider.
 *
 * A sentinel rather than an empty string, so anyone reading the column can tell at a glance
 * that there is nothing here to compare against. `verify` branches on `method`, never on this.
 */
const DELEGATED_TO_PROVIDER = 'delegated:twilio-verify'

/**
 * The marker stored in `challengeHash` when the answer is the user's PIN.
 *
 * There is nothing to put here: the PIN's bcrypt hash lives in `UserCredential`, deliberately
 * on a row of its own so the payment path is the only thing that ever loads it. Storing a
 * second copy per challenge would multiply the number of places a hash can leak from by the
 * number of payments the user makes.
 */
const DELEGATED_TO_PIN = 'delegated:user-pin'

/**
 * Purposes a PIN may NOT answer, whatever the user has enrolled.
 *
 * The PIN authorises ACTIONS — `TRANSACTION`, `CLAIM`, `CONSENT` — and those are the cases it
 * is preferred for (see {@link StepUpService.resolveMethod}). The exclusions below are not
 * stylistic; each one is a specific bypass:
 *
 *  - `DEVICE_BIND` / `DEVICE_RECOVERY` — the SMS *is* the control. Its value is not the six
 *    digits, it is that they arrive on the SIM in the handset, which is the only thing that
 *    makes the device-to-number pairing mean anything. A PIN proves knowledge and says nothing
 *    about which phone holds it, so accepting one here would let a shoulder-surfed PIN bind an
 *    attacker's own device — manufacturing the possession factor every later challenge, PIN
 *    included, is then measured against. This is the load-bearing exclusion.
 *
 *  - `LOGIN` — a login challenge fires precisely BECAUSE the sign-in looked wrong. Answering it
 *    with a knowledge factor concedes the point: what is in doubt is whether the person holds
 *    the account's phone, and only the out-of-band code speaks to that.
 *
 *  - `PIN_CHANGE` — a PIN that can authorise its own replacement has no recovery boundary at
 *    all: one shoulder-surfed entry becomes permanent control, because the attacker's first
 *    move is to set a PIN the real user does not know. The change is gated on biometric
 *    exactly because the proof must be a DIFFERENT factor from the thing being changed.
 *
 *  - `PIN_RESET` — reset exists for the user who has forgotten or locked the PIN. Requiring the
 *    PIN to reset the PIN is a deadlock with no route back.
 */
const PIN_INELIGIBLE_PURPOSES: ReadonlySet<StepUpPurpose> = new Set([
  StepUpPurpose.DEVICE_BIND,
  StepUpPurpose.DEVICE_RECOVERY,
  StepUpPurpose.LOGIN,
  StepUpPurpose.PIN_CHANGE,
  StepUpPurpose.PIN_RESET,
])

export interface IssuedChallenge {
  challengeId: string
  nonce: string
  method: StepUpMethod
  purpose: StepUpPurpose
  expiresAt: Date
  /** Why the user is being challenged, in plain language. */
  reason: string
  /**
   * The secret a BIOMETRIC or PIN_REAUTH challenge must echo back. Absent for OTP.
   *
   * ## Why this is returned to the client at all
   *
   * A biometric check happens ON THE HANDSET — there is no out-of-band channel to deliver a
   * secret through, the way an OTP has SMS. So the app is given a value and returns it only
   * after the OS reports a successful local authentication.
   *
   * ## The honest limit of that, stated plainly
   *
   * This proves the app COMPLETED a local check, not that a fingerprint was actually
   * presented. An attacker holding a live session token could echo it back immediately without
   * authenticating. It is an app-level factor, not a cryptographic one.
   *
   * A hardware-attested version has the device SIGN a challenge with a keystore key whose
   * access is gated by biometry — `holder-key.ts` already does exactly that for M3
   * presentations, so the primitive exists in this codebase. That is the production hardening
   * step, and it is precisely why `DEVICE_INTEGRITY` carries a 0.45 weight: on a rooted device
   * this factor is weak, and the two controls cover each other's gap.
   */
  assertion?: string
}

export interface VerifiedChallenge {
  ok: true
  purpose: StepUpPurpose
  subjectId: string | null
  assessmentId: string | null
  /** Returned once, on a DEVICE_BIND challenge. Never stored in the clear. */
  bindingToken?: string
}

/**
 * Dynamic second-factor orchestration — the RBI mandate (effective 1 April 2026) in
 * code.
 *
 * A step-up is the highest-leverage control in the whole module, and the reason is
 * economic rather than cryptographic: it does not block, it raises the COST of the
 * attack. A remote attacker holding phished credentials usually cannot produce a
 * factor bound to the handset, so the challenge converts a successful credential theft
 * into a dead end without inconveniencing the legitimate user beyond one tap.
 *
 * ## The four things that make a challenge actually secure
 *
 *  1. **A single-use nonce** (T13 — replay). A captured challenge cannot be answered
 *     twice, and the status transition out of `PENDING` is what enforces it.
 *  2. **An attempt cap** — three guesses, then FAILED. Six digits with unlimited
 *     guesses is not a factor.
 *  3. **An expiry** — five minutes. A challenge captured from a log or a shoulder-surf
 *     is worthless shortly after.
 *  4. **Purpose and subject binding.** This is the one the M6 build doc omitted, and
 *     it is a real vulnerability rather than a nicety: without it, a challenge issued
 *     for a ₹100 transfer can be redeemed against a ₹100,000 one, or a bind challenge
 *     replayed to release a held payment. The confused-deputy shape. `verify` requires
 *     the caller to state the purpose and subject it expects, and refuses a mismatch.
 *
 * ## What this never does
 *
 * It never sees or stores a UPI PIN. That is entered in the bank's own secure
 * component and never reaches our servers — M4's rule, and non-negotiable. M6
 * orchestrates OUR challenge; authorisation of money still happens on the rail.
 */
@Injectable()
export class StepUpService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly velocity: VelocityService,
    private readonly devices: DeviceTrustService,
    /**
     * Holds the PIN's bcrypt hash, its attempt counter and its lockout.
     *
     * A plain injection with no `forwardRef`, because there is no cycle: `PinService` depends
     * on Prisma, `DeviceTrustService` and `AuditService`, and none of those reaches back here.
     * Worth stating because it is the kind of edge that gets "tidied" into a `forwardRef`
     * defensively later — and a `forwardRef` here would fail at RUNTIME, mid-payment, which is
     * strictly worse than failing at boot.
     */
    private readonly pins: PinService,
    /**
     * The SAME provider the login path uses.
     *
     * Not `SmsService` (MSG91), which is what this service used to call and which is not
     * configured in this deployment — so no step-up code was ever delivered. Reusing
     * `TwilioVerifyService` also inherits its DEV bypass, so a step-up on the configured
     * bypass number works in testing with the same code as login and needs no separate
     * dev-only path here.
     */
    private readonly twilio: TwilioVerifyService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: StepUpService.name })
  }

  // ── issue ─────────────────────────────────────────────────────────────────
  /**
   * Issue a challenge.
   *
   * Refuses when the user is already under a step-up lockout. That check closes the
   * gap the per-challenge attempt cap leaves open: three guesses per challenge with
   * unlimited challenges is unlimited guesses, so an attacker would simply request a
   * fresh challenge after every third miss.
   */
  async issue(params: {
    userId: string
    method?: StepUpMethod
    purpose: StepUpPurpose
    subjectId?: string | null
    assessmentId?: string | null
    reason?: string
  }): Promise<IssuedChallenge> {
    const failures = await this.velocity.stepUpFailures(params.userId)
    if (failures >= STEP_UP.FAIL_LOCKOUT_COUNT) {
      this.logger.warn(
        `[${this.issue.name}] Refusing to issue — user is under a step-up lockout`,
        { userId: params.userId, failures },
      )
      throw new ForbiddenException(
        'Too many failed verification attempts. Please try again later or contact support.',
      )
    }

    /**
     * Invalidate any other PENDING challenge for the same purpose and subject.
     *
     * Without this, requesting a second challenge leaves the first redeemable, so an
     * attacker who intercepted OTP #1 can wait for the user to give up, request a new
     * one themselves, and still use the old code. One live challenge per action.
     */
    await this.prisma.stepUpChallenge.updateMany({
      where: {
        userId: params.userId,
        purpose: params.purpose,
        subjectId: params.subjectId ?? null,
        status: StepUpStatus.PENDING,
      },
      data: { status: StepUpStatus.EXPIRED, resolvedAt: new Date() },
    })

    const method =
      params.method ?? (await this.resolveMethod(params.userId, params.purpose))

    /**
     * An OTP challenge's code is generated, sent AND checked by TWILIO VERIFY.
     *
     * ## Why this is delegated rather than done here
     *
     * This service used to mint its own six digits and post them through MSG91, and that
     * was broken in a way no test caught: MSG91 is not configured in this deployment — the
     * auth path moved to Twilio Verify long ago — so `SmsService.isEnabled()` was false,
     * nothing was ever delivered, and the user got a prompt reading "enter the code we sent
     * you" for a code that did not exist. An unanswerable challenge on a held payment is
     * worse than no challenge at all: the money is stopped and there is no route out.
     *
     * Twilio Verify owns the code lifecycle — generation, delivery, its own expiry and its
     * own attempt limits — and the app never sees the digits. So there is nothing to hash,
     * and `challengeHash` stores a marker instead.
     *
     * ## What this service still owns, and why the row is still needed
     *
     * Twilio knows only a phone number. It has no idea what the code AUTHORISES. So the
     * `StepUpChallenge` row remains the source of truth for everything that makes a
     * challenge safe rather than merely delivered:
     *
     *  - the single-use `nonce`,
     *  - the `purpose` + `subjectId` binding that stops a code issued for a ₹100 transfer
     *    being redeemed against a ₹100,000 one,
     *  - our own attempt cap and the cross-challenge lockout above.
     *
     * Twilio's own limits then apply on top. Two independent caps is the right posture.
     */
    const delegated = method === StepUpMethod.OTP

    /**
     * Three methods, three places the expected answer lives. None of them is here.
     *
     *  - `OTP` — at Twilio. Delivered by SMS, checked by Twilio, never seen by us.
     *  - `PIN_REAUTH` — in `UserCredential.pinHash`, bcrypt at cost 12. The challenge row
     *    carries a marker, and `verify` hands the answer to {@link PinService}.
     *  - `BIOMETRIC` — a random secret handed to the device, echoed back after the OS reports
     *    a passing local check. This one alone keeps the generate-and-hash scheme, because the
     *    check happens on the handset and there is no out-of-band channel to use instead.
     *
     * ## Why the PIN is NOT given the device-secret treatment
     *
     * It would have been one fewer branch, and it would have been a hole straight through the
     * feature. The secret-echo scheme proves only that the APP completed something; the app
     * decides when to echo. A PIN handled that way could be "verified" by an app — or a
     * repackaged app, or a replayed HTTP call — that never rendered a keypad at all, and the
     * server would have no way to tell. The entire reason to prefer a PIN over an OTP is that
     * the SERVER checks a secret only the human knows, so the check has to happen server-side.
     *
     * The biometric keeps the weaker scheme because there is genuinely no alternative short of
     * hardware attestation, and its honest limits are documented on `IssuedChallenge.assertion`.
     */
    const secret =
      method === StepUpMethod.BIOMETRIC
        ? randomBytes(32).toString('base64url')
        : null

    /**
     * Delivery happens BEFORE the row is written, and a failure aborts the issue.
     *
     * The opposite order is what produced the bug above — a challenge row that exists while
     * nothing was sent IS an unanswerable challenge. Sending first means a delivery failure
     * surfaces as a clean error the caller can act on, and leaves no dead row for the user
     * to stare at.
     */
    if (delegated) {
      await this.sendVerification(params.userId, params.purpose)
    }

    const challenge = await this.prisma.stepUpChallenge.create({
      data: {
        userId: params.userId,
        method,
        purpose: params.purpose,
        subjectId: params.subjectId ?? null,
        assessmentId: params.assessmentId ?? null,
        nonce: randomUUID(),
        /**
         * A marker, not a hash, for a delegated challenge.
         *
         * `''` would be indistinguishable from "the hash of the empty string". It could not
         * actually be exploited — `hashesEqual(sha256(''), '')` is false — but a reader
         * comparing this column against an answer needs to see at a glance that there is
         * nothing here to compare. `verify` branches on `method`, never on this value.
         */
        challengeHash: secret
          ? sha256(secret)
          : delegated
            ? DELEGATED_TO_PROVIDER
            : DELEGATED_TO_PIN,
        maxAttempts: STEP_UP.MAX_ATTEMPTS,
        expiresAt: new Date(Date.now() + STEP_UP.TTL_MS),
      },
    })

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      actorId: params.userId,
      action: 'stepup.issued',
      entity: 'StepUpChallenge',
      entityId: challenge.id,
      metadata: { purpose: params.purpose, method },
    })

    return {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      method,
      purpose: params.purpose,
      expiresAt: challenge.expiresAt,
      reason: params.reason ?? 'For your security, please confirm this action.',
      /**
       * The device-held secret, for a non-OTP challenge only.
       *
       * There is deliberately no `devOtp` counterpart for the OTP case: Twilio owns that code
       * and we never see it, so there is nothing to echo. Testing an OTP flow without a real
       * SMS goes through `TwilioVerifyService`'s DEV bypass — keyed on one number rather than
       * switched on globally, and unable to leak a real user's code.
       */
      assertion: secret ?? undefined,
    }
  }

  // ── method selection ──────────────────────────────────────────────────────
  /**
   * Which factor to ask for, when the caller has not insisted on one.
   *
   * ## Why the PIN is preferred over the OTP wherever it is allowed
   *
   * Because an SMS OTP is a *weaker* factor for authorising a payment than the user's own
   * PIN, and it took a user pointing at a live step-up screen to see it. The code arrives on
   * the lock screen of the handset. Anyone already holding that unlocked phone — the exact
   * threat a payment factor exists to stop, and by a wide margin the most common one in
   * practice — reads it and pays. The OTP proves possession of a phone the attacker already
   * has; it adds a step, not a factor.
   *
   * The PIN proves KNOWLEDGE, which is the thing possession of the handset does not confer.
   * Combined with the bound device the transfer is coming from, that is a genuine two-factor
   * authorisation — possession plus knowledge — and it is the model every UPI app in the
   * market runs on. NPCI reached the same conclusion: UPI has never used an OTP to authorise
   * a payment, only the PIN.
   *
   * ## Why the OTP is still the fallback, not a legacy branch
   *
   * A user with no PIN enrolled must still be able to complete a challenged payment. Refusing
   * would strand them, and an SMS OTP — weaker as it is — is a real gate against a remote
   * attacker who has neither the phone nor the PIN. So the ladder degrades rather than blocks,
   * and {@link PIN_INELIGIBLE_PURPOSES} names the places where the OTP is not the weaker
   * option but the ONLY correct one.
   *
   * ## Why a locked PIN falls back rather than failing
   *
   * `canUsePin` is false while the PIN is locked out. Issuing a PIN challenge then would
   * produce a challenge the user provably cannot answer — the same unanswerable-challenge bug
   * that the Twilio migration existed to fix, arrived at from the other direction. They get an
   * OTP, and the reset path is where the PIN comes back.
   */
  private async resolveMethod(
    userId: string,
    purpose: StepUpPurpose,
  ): Promise<StepUpMethod> {
    if (PIN_INELIGIBLE_PURPOSES.has(purpose)) return StepUpMethod.OTP

    /**
     * A failure to READ the PIN's state must not decide the factor.
     *
     * Falling through to OTP on an error looks like the safe default and is the opposite: a
     * transient database blip would silently downgrade every payment in that window from the
     * strong factor to the weak one, and nothing anywhere would say so. An attacker who can
     * cause errors could aim for exactly that. So the read failing is a failure to issue —
     * the caller sees an error and the user retries — and the log line says which.
     */
    const enrolled = await this.pins
      .canUsePin(userId)
      .catch((error: unknown) => {
        this.logger.error(
          `[${this.resolveMethod.name}] Could not read PIN state — refusing to pick a factor`,
          { userId, purpose, err: error },
        )
        throw new ServiceUnavailableException(
          'We could not verify your security settings. Please try again.',
        )
      })

    return enrolled ? StepUpMethod.PIN_REAUTH : StepUpMethod.OTP
  }

  // ── verify ────────────────────────────────────────────────────────────────
  /**
   * Answer a challenge.
   *
   * `expectedPurpose` is REQUIRED, and `expectedSubjectId` is required whenever the
   * challenge carries one. This is the confused-deputy defence described above: a
   * caller must state what it believes it is authorising, and a challenge minted for
   * something else is refused rather than honoured.
   */
  async verify(params: {
    userId: string
    nonce: string
    answer: string
    expectedPurpose: StepUpPurpose
    expectedSubjectId?: string | null
    ipAddress?: string | null
  }): Promise<VerifiedChallenge> {
    const challenge = await this.prisma.stepUpChallenge.findUnique({
      where: { nonce: params.nonce },
    })

    /**
     * An unknown nonce and another user's nonce give the SAME error.
     *
     * Distinguishing them would turn this endpoint into an oracle for enumerating
     * live challenges.
     */
    if (!challenge || challenge.userId !== params.userId) {
      throw new BadRequestException('That verification code is not valid')
    }

    if (challenge.purpose !== params.expectedPurpose) {
      this.logger.warn(
        `[${this.verify.name}] Challenge purpose mismatch — refusing`,
        {
          userId: params.userId,
          issuedFor: challenge.purpose,
          presentedFor: params.expectedPurpose,
        },
      )
      throw new ForbiddenException(
        'That verification does not apply to this action',
      )
    }

    if (
      challenge.subjectId &&
      params.expectedSubjectId &&
      challenge.subjectId !== params.expectedSubjectId
    ) {
      this.logger.warn(
        `[${this.verify.name}] Challenge subject mismatch — refusing`,
        { userId: params.userId, purpose: challenge.purpose },
      )
      throw new ForbiddenException(
        'That verification does not apply to this action',
      )
    }

    if (
      !isStepUpRedeemable(
        challenge.status,
        challenge.expiresAt,
        challenge.attempts,
        challenge.maxAttempts,
      )
    ) {
      // Reflect the terminal state so a stale PENDING row is not left redeemable.
      if (
        challenge.status === StepUpStatus.PENDING &&
        challenge.expiresAt <= new Date()
      ) {
        await this.resolve(challenge.id, StepUpStatus.EXPIRED)
      }
      throw new BadRequestException(
        'That verification code has expired. Please request a new one.',
      )
    }

    /**
     * Who validates the answer depends on how it was delivered.
     *
     * An OTP goes to Twilio Verify, which holds the code — we never had it. A biometric or
     * PIN assertion is compared against our own stored hash in constant time.
     *
     * Note the ORDER: every one of OUR gates above (unknown nonce, purpose mismatch, subject
     * mismatch, expired, attempts exhausted) has already run. Twilio is asked last and only
     * about the digits, because it cannot answer any of the questions that actually make this
     * challenge safe.
     */
    let correct: boolean
    /**
     * A rejection from {@link PinService}, held so it can be rethrown after the challenge's own
     * bookkeeping has run.
     *
     * Its message is the one the user needs — "3 attempts remaining", or "locked, reset it" —
     * counted against the PIN's own 5-attempt/15-minute lockout, which is the authoritative
     * limit and survives across challenges. The challenge's 3-attempt counter still ticks,
     * because a nonce must not be grindable, but reporting ITS number here would tell the user
     * a figure that is not the one about to lock their PIN.
     */
    let pinRejection: Error | null = null

    switch (challenge.method) {
      case StepUpMethod.OTP:
        correct = await this.checkVerification(params.userId, params.answer)
        break
      case StepUpMethod.PIN_REAUTH:
        try {
          await this.pins.verify({
            userId: params.userId,
            pin: params.answer,
            ipAddress: params.ipAddress,
          })
          correct = true
        } catch (error) {
          /**
           * Narrowed to `Error` rather than rethrown as `unknown`.
           *
           * Everything `PinService.verify` throws is an `HttpException`, so this always holds —
           * but a bare `throw someUnknown` loses the status code Nest reads off it, and a
           * non-Error value would surface as a 500 with no message where the user needed
           * "2 attempts remaining". Anything that is somehow not an `Error` falls through to the
           * generic refusal below, which is the safe direction: it denies.
           */
          pinRejection = error instanceof Error ? error : null
          correct = false
        }
        break
      default:
        correct = hashesEqual(sha256(params.answer), challenge.challengeHash)
    }

    if (!correct) {
      const updated = await this.prisma.stepUpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      })

      await this.velocity.recordStepUpFailure(params.userId)

      if (updated.attempts >= updated.maxAttempts) {
        await this.resolve(challenge.id, StepUpStatus.FAILED)

        /**
         * An exhausted bind challenge counts against the device's lockout, not just
         * the user's. A device somebody is grinding challenges against should stop
         * being bindable.
         */
        if (
          challenge.purpose === StepUpPurpose.DEVICE_BIND &&
          challenge.subjectId
        ) {
          await this.devices.recordBindFailure(challenge.subjectId)
        }

        this.logger.warn(
          `[${this.verify.name}] Challenge failed — attempts exhausted`,
          { userId: params.userId, purpose: challenge.purpose },
        )

        /**
         * "code" for a delivered secret, "confirmation" for a PIN.
         *
         * A live probe surfaced this: three wrong PINs exhausted the challenge and told the user
         * to "request a new code", for a PIN nobody had sent them. Small, and exactly the kind of
         * wording that sends somebody hunting through their SMS inbox for a message that does not
         * exist.
         *
         * Worth noting what the two counters mean together, since they differ: the challenge
         * allows 3 attempts and the PIN 5. So a user hits this branch first and re-requests, and
         * the PIN's counter carries across challenges — the effective budget stays 5, and the
         * lockout remains the authoritative limit. The challenge cap is there so one nonce cannot
         * be ground indefinitely, not to be the user-facing number.
         */
        throw new BadRequestException(
          challenge.method === StepUpMethod.PIN_REAUTH
            ? 'Too many incorrect attempts. Please start the confirmation again.'
            : 'Too many incorrect attempts. Please request a new code.',
        )
      }

      // The PIN's own message, for the reasons on `pinRejection`.
      if (pinRejection) throw pinRejection

      throw new BadRequestException(
        `That code is not correct. ${updated.maxAttempts - updated.attempts} attempts remaining.`,
      )
    }

    /**
     * Mark PASSED with the status still PENDING in the WHERE clause.
     *
     * A conditional update, so two concurrent verifications of one nonce cannot both
     * succeed — the database arbitrates and the loser sees zero rows affected. This is
     * the actual single-use guarantee; checking `status === PENDING` in application
     * code above is a fast path, not the control.
     */
    const claimed = await this.prisma.stepUpChallenge.updateMany({
      where: { id: challenge.id, status: StepUpStatus.PENDING },
      data: { status: StepUpStatus.PASSED, resolvedAt: new Date() },
    })

    if (claimed.count === 0) {
      throw new BadRequestException(
        'That verification code has already been used',
      )
    }

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: params.userId,
      action: 'stepup.passed',
      entity: 'StepUpChallenge',
      entityId: challenge.id,
      metadata: { purpose: challenge.purpose },
      ipAddress: params.ipAddress ?? null,
    })

    // ── purpose-specific completion ──
    let bindingToken: string | undefined

    if (
      challenge.purpose === StepUpPurpose.DEVICE_BIND &&
      challenge.subjectId
    ) {
      /**
       * The binding token is generated HERE and returned ONCE.
       *
       * Only its hash is stored, exactly like an OTP — a device-binding token that
       * can be read out of a database backup is a device binding an attacker can
       * assume without touching the handset.
       */
      bindingToken = randomBytes(32).toString('base64url')
      await this.devices.completeBind(
        challenge.subjectId,
        sha256(bindingToken),
        {
          ipAddress: params.ipAddress,
        },
      )
    }

    return {
      ok: true,
      purpose: challenge.purpose,
      subjectId: challenge.subjectId,
      assessmentId: challenge.assessmentId,
      bindingToken,
    }
  }

  /**
   * Read a pending challenge's purpose without consuming it.
   *
   * Exists for the generic verify endpoint, which has to know which purpose to assert
   * before it can assert it. It returns ONLY the purpose and subject — never the
   * `challengeHash`, the attempt count or the expiry — because this is reachable by any
   * authenticated caller holding a nonce, and leaking the attempt count would tell an
   * attacker exactly how many guesses remain.
   *
   * An unknown nonce and another user's nonce give the same error, so the endpoint
   * cannot be used to enumerate live challenges.
   */
  async peek(
    userId: string,
    nonce: string,
  ): Promise<{ purpose: StepUpPurpose; subjectId: string | null }> {
    const challenge = await this.prisma.stepUpChallenge.findUnique({
      where: { nonce },
      select: { userId: true, purpose: true, subjectId: true },
    })

    if (!challenge || challenge.userId !== userId) {
      throw new NotFoundException('That verification code is not valid')
    }

    return { purpose: challenge.purpose, subjectId: challenge.subjectId }
  }

  /**
   * The live PENDING challenge for an action, if there is one.
   *
   * ## Why this exists, and the bug it closes
   *
   * When M4 parks a transfer as `STEP_UP`, the transaction it returns says `RISK_HELD` and
   * nothing else — so the app knew a challenge was required but had no NONCE to answer it
   * with. The control was unreachable from the client: a user would see "awaiting your
   * confirmation" with no way to confirm. The transfer controller now folds this into the
   * presented transaction, on both `create` AND `detail`.
   *
   * `detail` matters as much as `create`: the app can be killed between the two, so a resume
   * has to be able to re-discover the challenge rather than stranding the payment forever.
   *
   * ## Why returning the nonce is safe
   *
   * A nonce is an IDENTIFIER, not a secret. The secret is the answer, which travels out of band
   * by SMS. Returning the nonce to the authenticated owner of the action is exactly what
   * `POST /security/step-up/request` already does — withholding it here would not add security,
   * it would only make the challenge unanswerable.
   *
   * `challengeHash` and `attempts` are deliberately NOT returned. The hash is the secret's
   * verifier, and the attempt count would tell an attacker how many guesses remain.
   */
  /**
   * What has ALREADY happened to challenges for one action, ignoring live ones.
   *
   * Exists so a caller can tell a lapsed step-up from something that was never challenged at all.
   * `RISK_HELD` on a transfer means either "waiting for the user" or "waiting for an analyst",
   * and `pendingFor` returning null cannot distinguish them — which would let a re-issue button
   * mint a code that releases a payment a reviewer deliberately stopped.
   *
   * Returns FACTS, not a verdict: whether any challenge ever existed, and whether one burned
   * through its attempts. The policy built on them belongs to the caller, because "may this be
   * re-issued" is a different question in payments than it is in insurance.
   */
  async historyFor(params: {
    userId: string
    purpose: StepUpPurpose
    subjectId: string
  }): Promise<{ everChallenged: boolean; exhausted: boolean }> {
    const challenges = await this.prisma.stepUpChallenge.findMany({
      where: {
        userId: params.userId,
        purpose: params.purpose,
        subjectId: params.subjectId,
      },
      select: { status: true, attempts: true, maxAttempts: true },
    })

    return {
      everChallenged: challenges.length > 0,
      /**
       * Exhausted on ANY challenge, not merely the latest.
       *
       * Reading only the most recent row would make the cap trivially resettable: burn three
       * guesses, let it lapse, ask again, and the new row's clean counter reports no exhaustion.
       * The whole point of the check is that the budget is spent for this ACTION, not for this
       * row.
       */
      exhausted: challenges.some(
        (challenge) =>
          challenge.status === StepUpStatus.FAILED ||
          challenge.attempts >= challenge.maxAttempts,
      ),
    }
  }

  async pendingFor(params: {
    userId: string
    purpose: StepUpPurpose
    subjectId: string
  }): Promise<{
    nonce: string
    method: StepUpMethod
    expiresAt: Date
    attemptsRemaining: number
  } | null> {
    const challenge = await this.prisma.stepUpChallenge.findFirst({
      where: {
        userId: params.userId,
        purpose: params.purpose,
        subjectId: params.subjectId,
        status: StepUpStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        nonce: true,
        method: true,
        expiresAt: true,
        attempts: true,
        maxAttempts: true,
      },
    })

    if (!challenge) return null

    return {
      nonce: challenge.nonce,
      method: challenge.method,
      expiresAt: challenge.expiresAt,
      /**
       * How many guesses are LEFT, rather than how many have been used.
       *
       * The app has to render "2 attempts remaining", and computing it client-side from a raw
       * count would need `maxAttempts` too — two fields where one suffices, and a subtraction
       * for a client to get wrong.
       */
      attemptsRemaining: Math.max(
        0,
        challenge.maxAttempts - challenge.attempts,
      ),
    }
  }

  /**
   * Whether a PASSED challenge exists for an action, without consuming anything.
   *
   * Used by M4 to let a stepped-up transfer proceed. Scoped to a short freshness
   * window, because a challenge passed an hour ago is not authorisation for an action
   * taken now — and to the exact subject, so passing a challenge on one transfer does
   * not authorise every later one.
   */
  async hasPassed(params: {
    userId: string
    purpose: StepUpPurpose
    subjectId: string
    withinMs?: number
  }): Promise<boolean> {
    const since = new Date(Date.now() - (params.withinMs ?? STEP_UP.TTL_MS))

    const passed = await this.prisma.stepUpChallenge.findFirst({
      where: {
        userId: params.userId,
        purpose: params.purpose,
        subjectId: params.subjectId,
        status: StepUpStatus.PASSED,
        resolvedAt: { gte: since },
      },
      select: { id: true },
    })

    return passed !== null
  }

  /**
   * Sweep expired PENDING challenges into `EXPIRED`.
   *
   * Housekeeping, so the analyst view and the lockout counters are not polluted by
   * rows that are dead but still labelled pending. Correctness does not depend on it —
   * `isStepUpRedeemable` checks the clock — but a queue full of stale PENDING rows is
   * how an operator loses trust in a dashboard.
   */
  async expireStale(): Promise<number> {
    const result = await this.prisma.stepUpChallenge.updateMany({
      where: { status: StepUpStatus.PENDING, expiresAt: { lt: new Date() } },
      data: { status: StepUpStatus.EXPIRED, resolvedAt: new Date() },
    })
    return result.count
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private resolve(id: string, status: StepUpStatus): Promise<StepUpChallenge> {
    return this.prisma.stepUpChallenge.update({
      where: { id },
      data: { status, resolvedAt: new Date() },
    })
  }

  /**
   * Ask Twilio Verify to generate and send a code.
   *
   * ## Why a failure THROWS here, unlike most of this module
   *
   * Everywhere else in M6 a side-effect failure is logged and swallowed, because the action
   * being protected matters more than the telemetry. This is the opposite case: if the code
   * was not sent, the challenge cannot be answered, and issuing one anyway strands whatever
   * it was guarding. The caller must learn that no channel was available.
   *
   * ## The bypass is inherited, deliberately
   *
   * `TwilioVerifyService` short-circuits the configured DEV bypass number and checks the
   * bypass code locally. Reusing that service rather than calling Twilio directly means a
   * step-up on the bypass number works in testing with the SAME code as login, with no extra
   * configuration and no separate dev-only path in this file.
   */
  private async sendVerification(
    userId: string,
    purpose: StepUpPurpose,
  ): Promise<void> {
    const phone = await this.phoneFor(userId)

    if (!this.twilio.isEnabled()) {
      this.logger.error(
        `[${this.sendVerification.name}] No verification channel configured — refusing to issue an unanswerable challenge`,
        { userId, purpose },
      )
      throw new ServiceUnavailableException(
        'We cannot send a verification code right now. Please try again shortly.',
      )
    }

    try {
      await this.twilio.sendSms(phone)
    } catch (error) {
      this.logger.error(
        `[${this.sendVerification.name}] Failed to send a step-up code`,
        { err: error, userId, purpose },
      )
      throw new ServiceUnavailableException(
        'We could not send your verification code. Please try again.',
      )
    }
  }

  /**
   * Ask Twilio Verify whether a code is correct.
   *
   * Returns FALSE on a provider error rather than throwing, and that asymmetry with
   * `sendVerification` is deliberate. A failure to send must abort — the user cannot
   * proceed. A failure to CHECK must read as "not correct", because the alternative is a
   * 500 on the verify endpoint, which an attacker can use to distinguish a wrong code from a
   * provider blip and which tells a legitimate user nothing they can act on.
   *
   * `check` already maps Twilio's 404 (no pending verification — expired, consumed, or too
   * many attempts) to false, so an exception here means a genuine transport failure.
   */
  private async checkVerification(
    userId: string,
    answer: string,
  ): Promise<boolean> {
    try {
      const phone = await this.phoneFor(userId)
      return await this.twilio.check(phone, answer)
    } catch (error) {
      this.logger.error(
        `[${this.checkVerification.name}] Verification check failed at the provider`,
        { err: error, userId },
      )
      return false
    }
  }

  /**
   * The user's E.164 number, or a refusal.
   *
   * A user with no phone on file cannot receive a code, so issuing a challenge for them
   * would be unanswerable by construction. Refused rather than logged, for the same reason
   * as an unconfigured channel.
   */
  private async phoneFor(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    })
    if (!user?.phone) {
      throw new ServiceUnavailableException(
        'No mobile number is on file for this account, so we cannot send a code.',
      )
    }
    return user.phone
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
