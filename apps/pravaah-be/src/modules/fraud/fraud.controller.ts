import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  BindDeviceSchema,
  ChangePinSchema,
  ConfirmBindSchema,
  EnrolBiometricSchema,
  RecoverDeviceSchema,
  RequestStepUpSchema,
  ResetPinSchema,
  SetPinSchema,
  VerifyPinSchema,
  VerifyStepUpSchema,
  type BindDeviceDto,
  type ChangePinDto,
  type ConfirmBindDto,
  type EnrolBiometricDto,
  type RecoverDeviceDto,
  type RequestStepUpDto,
  type ResetPinDto,
  type SetPinDto,
  type VerifyPinDto,
  type VerifyStepUpDto,
} from '@pravaah/schema'

import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { SECURITY_ROUTES } from '@/modules/fraud/fraud.route'
import { hashSimSerial } from '@/modules/fraud/risk-hash.util'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { PinService } from '@/modules/fraud/services/pin.service'
import { RiskService } from '@/modules/fraud/services/risk.service'
import { StepUpService } from '@/modules/fraud/services/step-up.service'

import {
  ActorType,
  RiskSubjectType,
  StepUpMethod,
  StepUpPurpose,
} from 'generated/prisma/client'

/**
 * The user's own security surface.
 *
 * M6 is mostly not a user-facing module — it is called in-process by M0/M1/M4/M5 at
 * their decision points. What IS user-facing is the part that builds trust rather than
 * merely applying control:
 *
 *  - **Device management**, including a one-tap "this wasn't me". Self-service is the
 *    fastest ATO defence there is: the account holder notices a strange device before
 *    any model does, and making them wait for support is how a takeover becomes a loss.
 *  - **The step-up prompt.** The visible face of the module. It should feel protective,
 *    not accusatory, which is why every challenge carries a plain-language reason.
 *  - **"My security activity."** Recent decisions and why they were made. This is the
 *    DPDP automated-decision-transparency answer made tangible, and it is also the
 *    cheapest support-cost reduction in the product: a user who can see "held: unusual
 *    amount from a device added minutes ago" does not open a ticket.
 *
 * Every route is scoped to the authenticated user. Nothing here accepts a `userId`, and
 * that is the control — a device-revoke endpoint that took a user id from the body would
 * let anybody sign anybody else out.
 */
@Controller(SECURITY_ROUTES.BASE)
@UseGuards(AuthGuard)
export class FraudController {
  private readonly logger: AppLogger

  constructor(
    private readonly devices: DeviceTrustService,
    private readonly stepUp: StepUpService,
    private readonly pins: PinService,
    private readonly risk: RiskService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FraudController.name })
  }

  // ── devices ───────────────────────────────────────────────────────────────
  @Get(SECURITY_ROUTES.DEVICES)
  async listDevices(@User() user: AuthenticatedUser) {
    const devices = await this.devices.listForUser(user.id)
    return ResponseBuilder.success(
      devices.map((device) => ({
        ...device,
        /**
         * Surfaced so the app can explain a challenge before it happens ("large
         * transfers need extra confirmation for the first day on a new device")
         * rather than after the user has typed an amount.
         */
        inCoolingOff: Boolean(
          device.coolingOffUntil && device.coolingOffUntil > new Date(),
        ),
      })),
      'Your registered devices',
    )
  }

  /**
   * Begin registering this device.
   *
   * Returns a CHALLENGE, never a binding token. A bind that handed back credentials
   * before the challenge was answered would make the challenge decorative — and that is
   * precisely the account-takeover scenario, where the attacker already has the session
   * and needs only a trusted device.
   */
  @Post(SECURITY_ROUTES.DEVICE_BIND)
  async bindDevice(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(BindDeviceSchema)) dto: BindDeviceDto,
    @Req() req: { ip?: string },
  ) {
    const ticket = await this.devices.beginBind(user.id, dto, {
      ipAddress: req.ip,
    })

    if (ticket.alreadyBound) {
      return ResponseBuilder.success(
        { deviceRef: ticket.deviceRef, status: ticket.status, stepUp: null },
        'This device is already registered',
      )
    }

    /**
     * Score the bind BEFORE issuing the challenge.
     *
     * Not to decide whether to challenge — a bind always gets one — but so the
     * assessment exists and the signals are recorded. A bind from an emulator on a
     * network already flagged for stuffing is exactly the event a case should carry, and
     * scoring after the challenge would lose it if the challenge went unanswered.
     */
    const assessment = await this.risk.scoreDeviceBind({
      userId: user.id,
      subjectType: RiskSubjectType.DEVICE_BIND,
      subjectId: ticket.deviceRef,
      clientDeviceId: dto.deviceId,
      deviceRef: ticket.deviceRef,
      ipAddress: req.ip,
      geoHint: dto.geoHint,
      sensitive: true,
    })

    const challenge = await this.stepUp.issue({
      userId: user.id,
      method: StepUpMethod.OTP,
      purpose: StepUpPurpose.DEVICE_BIND,
      subjectId: ticket.deviceRef,
      assessmentId: assessment.assessmentId,
      reason: 'Confirm the code we sent you to register this device.',
    })

    return ResponseBuilder.success(
      {
        deviceRef: ticket.deviceRef,
        status: ticket.status,
        stepUp: {
          nonce: challenge.nonce,
          method: challenge.method,
          expiresAt: challenge.expiresAt,
          reason: challenge.reason,
        },
        /** What the risk engine noticed, so the app can be honest about the friction. */
        riskReasons: assessment.reasons,
      },
      'Enter the code we sent you to finish registering this device',
    )
  }

  /**
   * Finish registering by answering the challenge.
   *
   * The binding token comes back exactly ONCE. Only its hash is stored, so a lost token
   * cannot be recovered — the device re-binds instead. That is the same discipline
   * applied to an OTP, and for the same reason: a device-binding token readable from a
   * database backup is a device binding an attacker can assume without the handset.
   */
  @Post(SECURITY_ROUTES.DEVICE_BIND_CONFIRM)
  async confirmBind(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ConfirmBindSchema)) dto: ConfirmBindDto,
    @Req() req: { ip?: string },
  ) {
    const result = await this.stepUp.verify({
      userId: user.id,
      nonce: dto.nonce,
      answer: dto.answer,
      expectedPurpose: StepUpPurpose.DEVICE_BIND,
      ipAddress: req.ip,
    })

    return ResponseBuilder.success(
      {
        deviceRef: result.subjectId,
        bindingToken: result.bindingToken,
        /**
         * Told plainly, because it explains friction the user is about to meet. A user
         * who knows large transfers need extra confirmation today does not read the
         * next challenge as the app being broken.
         */
        coolingOff: true,
      },
      'This device is registered. Large payments will need extra confirmation for the first 24 hours.',
    )
  }

  /**
   * Remove a device. "This wasn't me."
   *
   * Deliberately requires NO step-up. Revoking is the safe direction, and a user who
   * suspects a compromise must be able to act immediately — demanding an OTP from
   * somebody whose SIM was just swapped denies them the one control that actually helps.
   * Binding is what costs a challenge; unbinding never should.
   */
  @Post(SECURITY_ROUTES.DEVICE_REVOKE)
  async revokeDevice(
    @User() user: AuthenticatedUser,
    @Param('id', UUIDValidationPipe) deviceRef: string,
    @Req() req: { ip?: string },
  ) {
    await this.devices.revoke({
      userId: user.id,
      deviceRef,
      actor: { type: ActorType.USER, id: user.id },
      reason: 'Removed by the account holder',
      ipAddress: req.ip,
    })

    this.logger.warn(`[${this.revokeDevice.name}] User revoked a device`, {
      userId: user.id,
      deviceRef,
    })

    return ResponseBuilder.success(
      { deviceRef, status: 'REVOKED' },
      'That device can no longer access your account',
    )
  }

  /**
   * Re-verify a device after a legitimate SIM change.
   *
   * The recovery path for somebody who simply replaced their SIM. It still costs a
   * step-up, because the attacker who swapped the victim's SIM would like to use exactly
   * this endpoint — and it RE-ANCHORS the serial, so the legitimate user's new SIM
   * becomes the new baseline while an attacker who cannot pass leaves the device frozen.
   */
  @Post(SECURITY_ROUTES.DEVICE_RECOVER)
  async recoverDevice(
    @User() user: AuthenticatedUser,
    @Param('id', UUIDValidationPipe) deviceRef: string,
    @Body(new ZodValidationPipe(RecoverDeviceSchema)) dto: RecoverDeviceDto,
    @Req() req: { ip?: string },
  ) {
    await this.stepUp.verify({
      userId: user.id,
      nonce: dto.nonce,
      answer: dto.answer,
      expectedPurpose: StepUpPurpose.DEVICE_RECOVERY,
      expectedSubjectId: deviceRef,
      ipAddress: req.ip,
    })

    const device = await this.devices.recover(
      deviceRef,
      dto.simSerial ? hashSimSerial(dto.simSerial) : null,
    )

    return ResponseBuilder.success(
      { deviceRef: device.id, status: device.status },
      'This device is verified again. Large payments will need extra confirmation for the next 24 hours.',
    )
  }

  /**
   * Rotate this device's binding token.
   *
   * Maintenance, not authentication — so no step-up. The caller already holds a valid
   * session AND the device is already `ACTIVE`; demanding an OTP to refresh a credential
   * the client legitimately holds would train users to expect OTP prompts they cannot
   * distinguish from an attacker's.
   *
   * `FraudSchedulerService.flagStaleTokens` records a `TOKEN_REFRESH` event on devices
   * past `BINDING_TOKEN_TTL_MS`, which is the app's cue to call this. Deliberately NOT a
   * forced revoke: locking somebody out for not opening the app for a week is how a
   * hygiene measure gets switched off by the first operator paged for it.
   */
  @Post(SECURITY_ROUTES.DEVICE_REFRESH)
  async refreshDevice(
    @User() user: AuthenticatedUser,
    @Param('id', UUIDValidationPipe) deviceRef: string,
  ) {
    const rotated = await this.devices.rotateToken(user.id, deviceRef)

    return ResponseBuilder.success(
      {
        deviceRef,
        /** Returned ONCE. Only its hash is stored, exactly like an OTP. */
        bindingToken: rotated.bindingToken,
        rotatedAt: rotated.rotatedAt,
      },
      'This device has a fresh binding token',
    )
  }

  /** Ask for a recovery challenge on a swap-suspected device. */
  @Post(`${SECURITY_ROUTES.DEVICE_RECOVER}/request`)
  async requestRecovery(
    @User() user: AuthenticatedUser,
    @Param('id', UUIDValidationPipe) deviceRef: string,
  ) {
    const challenge = await this.stepUp.issue({
      userId: user.id,
      method: StepUpMethod.OTP,
      purpose: StepUpPurpose.DEVICE_RECOVERY,
      subjectId: deviceRef,
      reason:
        'We noticed the SIM in this device changed. Confirm the code we sent you.',
    })

    return ResponseBuilder.success(
      {
        nonce: challenge.nonce,
        method: challenge.method,
        expiresAt: challenge.expiresAt,
        reason: challenge.reason,
      },
      'Enter the code we sent you to verify this device',
    )
  }

  // ── step-up ───────────────────────────────────────────────────────────────
  /**
   * Ask for a challenge on an action that was told to step up.
   *
   * `purpose` and `subjectId` are both required, and the requirement is a real control
   * rather than bookkeeping: a challenge is scoped to one action, so a code issued for a
   * ₹100 transfer cannot be redeemed against a ₹100,000 one. `verify` re-checks both.
   */
  @Post(SECURITY_ROUTES.STEP_UP_REQUEST)
  async requestStepUp(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(RequestStepUpSchema)) dto: RequestStepUpDto,
  ) {
    /**
     * No `method` — the SERVICE picks it.
     *
     * This used to pin `StepUpMethod.OTP` here, and leaving that would have quietly defeated
     * the whole PIN feature: every challenge raised through this endpoint would have arrived
     * as an SMS code no matter what the user had enrolled. `StepUpService.resolveMethod`
     * prefers the PIN wherever the purpose allows it and falls back to OTP otherwise, and it
     * is the only place that decision should be made — a controller that hardcodes a factor is
     * a policy decision hiding in a transport layer.
     */
    const challenge = await this.stepUp.issue({
      userId: user.id,
      purpose: dto.purpose,
      subjectId: dto.subjectId,
      reason: 'For your security, please confirm this action.',
    })

    return ResponseBuilder.success(
      {
        nonce: challenge.nonce,
        method: challenge.method,
        expiresAt: challenge.expiresAt,
        reason: challenge.reason,
        /**
         * Present only for a BIOMETRIC challenge, and `undefined` otherwise.
         *
         * A PIN challenge deliberately carries nothing here: its answer is the PIN, checked
         * server-side against the stored hash. Returning a secret for the app to echo would
         * turn the PIN into something the app can assert rather than something the user must
         * know — see `StepUpService.issue`.
         */
        assertion: challenge.assertion,
      },
      messageForMethod(challenge.method),
    )
  }

  /**
   * Answer a challenge.
   *
   * The caller must state the purpose and subject it believes it is authorising, so this
   * generic endpoint cannot be used to redeem a challenge minted for something else.
   */
  @Post(SECURITY_ROUTES.STEP_UP_VERIFY)
  async verifyStepUp(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(VerifyStepUpSchema)) dto: VerifyStepUpDto,
    @Req() req: { ip?: string },
  ) {
    /**
     * The purpose is read from the CHALLENGE, not asserted by this caller.
     *
     * Safe here only because this endpoint does not itself perform a privileged action —
     * it merely marks the challenge passed, and the module that acts on it
     * (`StepUpService.hasPassed`) checks purpose and subject at the point of use. The
     * dedicated endpoints above assert an expected purpose precisely because they DO act.
     */
    const challenge = await this.stepUp.peek(user.id, dto.nonce)

    const result = await this.stepUp.verify({
      userId: user.id,
      nonce: dto.nonce,
      answer: dto.answer,
      expectedPurpose: challenge.purpose,
      ipAddress: req.ip,
    })

    return ResponseBuilder.success(
      {
        ok: result.ok,
        purpose: result.purpose,
        subjectId: result.subjectId,
        bindingToken: result.bindingToken,
      },
      'Verified. Your action can continue.',
    )
  }

  // ── the transaction PIN ───────────────────────────────────────────────────
  /**
   * Which factors this account has.
   *
   * The app calls this at launch to decide what to ask for on a payment: a PIN if one is
   * enrolled and unlocked, otherwise an SMS step-up. Returning it as one object rather than
   * letting the client infer it from a 404 on `verify` means the payment screen never has to
   * discover the answer by failing.
   */
  @Get(SECURITY_ROUTES.PIN_STATUS)
  async pinStatus(@User() user: AuthenticatedUser) {
    const status = await this.pins.status(user.id)
    return ResponseBuilder.success(status, 'Your security factors')
  }

  /**
   * Set the PIN for the first time.
   *
   * Refuses on an unbound device. The PIN is the knowledge half of a pair whose other half is
   * the bound device, so letting an unrecognised device establish it would collapse both
   * halves into whatever an attacker holding a session token already has. This mirrors UPI,
   * where a PIN cannot be registered until device binding has proved the SIM is in the
   * handset — which is exactly why the enrolment order is OTP → biometric → PIN.
   */
  @Post(SECURITY_ROUTES.PIN_SET)
  async setPin(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SetPinSchema)) dto: SetPinDto,
    @Req() req: { ip?: string },
  ) {
    const status = await this.pins.enrol({
      userId: user.id,
      pin: dto.pin,
      clientDeviceId: dto.deviceId,
      ipAddress: req.ip,
    })

    return ResponseBuilder.success(
      status,
      'Your payment PIN is set. You will be asked for it on payments.',
    )
  }

  /**
   * Answer a PIN challenge on an action.
   *
   * Verification alone does NOT authorise anything — it records that the PIN was correct. The
   * action that needed it is released by its own module (M4's transfer confirm), because only
   * that module knows what it was guarding. A verify endpoint that also released the action
   * would be a confused deputy: it has no idea which payment the caller means.
   */
  @Post(SECURITY_ROUTES.PIN_VERIFY)
  async verifyPin(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(VerifyPinSchema)) dto: VerifyPinDto,
    @Req() req: { ip?: string },
  ) {
    await this.pins.verify({
      userId: user.id,
      pin: dto.pin,
      ipAddress: req.ip,
    })
    return ResponseBuilder.success({ ok: true }, 'PIN confirmed')
  }

  /**
   * Ask for the BIOMETRIC challenge that authorises a PIN change.
   *
   * Issued as a `BIOMETRIC`-method challenge, which means the answer is a device-held secret
   * the app echoes after a successful local authentication — not an SMS. That is the point: a
   * change proved by SMS would let somebody holding the phone read the code and set their own
   * PIN, which is the exact bypass this whole design exists to close.
   */
  @Post(SECURITY_ROUTES.PIN_CHANGE_REQUEST)
  async requestPinChange(@User() user: AuthenticatedUser) {
    const status = await this.pins.status(user.id)
    if (!status.enrolled) {
      throw new BadRequestException(
        'No PIN is set on this account. Set one instead of changing it.',
      )
    }

    const challenge = await this.stepUp.issue({
      userId: user.id,
      method: StepUpMethod.BIOMETRIC,
      purpose: StepUpPurpose.PIN_CHANGE,
      subjectId: user.id,
      reason: 'Confirm with your fingerprint or face to change your PIN.',
    })

    return ResponseBuilder.success(
      {
        nonce: challenge.nonce,
        method: challenge.method,
        expiresAt: challenge.expiresAt,
        reason: challenge.reason,
        /**
         * The secret the device must echo back.
         *
         * Returned ONCE, to the authenticated owner, over TLS. This is the honest limit of a
         * software biometric: the app proves it completed a local check by returning a value
         * only it was given. A hardware-attested implementation would instead have the device
         * SIGN this with a keystore key — which is why `DEVICE_INTEGRITY` is a 0.45-weight
         * signal, since the two controls cover each other's gap.
         */
        assertion: challenge.assertion,
      },
      'Confirm with your fingerprint or face',
    )
  }

  /**
   * Change the PIN, having passed the biometric.
   *
   * The nonce IS the authorisation — there is deliberately no `biometricPassed: true` field,
   * because a boolean on the wire is not proof of anything a client could not simply assert.
   */
  @Post(SECURITY_ROUTES.PIN_CHANGE)
  async changePin(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ChangePinSchema)) dto: ChangePinDto,
    @Req() req: { ip?: string },
  ) {
    /**
     * The challenge is consumed HERE, immediately before the change.
     *
     * Not "was one passed recently" — consumed. A passed-challenge lookup with a freshness
     * window would let one biometric authorise several changes inside that window, and the
     * single-use nonce is what makes it exactly one.
     */
    await this.stepUp.verify({
      userId: user.id,
      nonce: dto.nonce,
      answer: dto.assertion,
      expectedPurpose: StepUpPurpose.PIN_CHANGE,
      expectedSubjectId: user.id,
      ipAddress: req.ip,
    })

    const status = await this.pins.change({
      userId: user.id,
      newPin: dto.newPin,
      ipAddress: req.ip,
    })

    return ResponseBuilder.success(status, 'Your payment PIN has been changed')
  }

  /**
   * Ask for the SMS challenge that authorises a PIN reset.
   *
   * SMS rather than biometric, and that is not an inconsistency: a reset exists precisely for
   * the user who CANNOT satisfy the other factors — they forgot the PIN, and they may be on a
   * device whose biometric is not enrolled. SMS is the only factor available to them.
   *
   * Which is exactly why the reset costs a cooling-off. See `PinService.reset`.
   */
  @Post(SECURITY_ROUTES.PIN_RESET_REQUEST)
  async requestPinReset(@User() user: AuthenticatedUser) {
    const challenge = await this.stepUp.issue({
      userId: user.id,
      method: StepUpMethod.OTP,
      purpose: StepUpPurpose.PIN_RESET,
      subjectId: user.id,
      reason:
        'Confirm the code we sent you to reset your PIN. Large payments will need extra confirmation for 24 hours afterwards.',
    })

    return ResponseBuilder.success(
      {
        nonce: challenge.nonce,
        method: challenge.method,
        expiresAt: challenge.expiresAt,
        reason: challenge.reason,
      },
      'Enter the code we sent you',
    )
  }

  /**
   * Reset the PIN, and pay for it with a 24-hour cooling-off on every device.
   *
   * The cooling-off is the load-bearing half. Without it a reset proved only by SMS is a way
   * around the PIN: read the code from the stolen phone, set a new PIN, pay. With it, the risk
   * ladder sees `DEVICE_NEW` for a day, so high-value transfers are challenged or held — "reset
   * and drain" becomes "reset, then wait while somebody reviews it".
   */
  @Post(SECURITY_ROUTES.PIN_RESET)
  async resetPin(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ResetPinSchema)) dto: ResetPinDto,
    @Req() req: { ip?: string },
  ) {
    await this.stepUp.verify({
      userId: user.id,
      nonce: dto.nonce,
      answer: dto.answer,
      expectedPurpose: StepUpPurpose.PIN_RESET,
      expectedSubjectId: user.id,
      ipAddress: req.ip,
    })

    const status = await this.pins.reset({
      userId: user.id,
      newPin: dto.newPin,
      ipAddress: req.ip,
    })

    return ResponseBuilder.success(
      status,
      'Your PIN has been reset. Larger payments will need extra confirmation for the next 24 hours.',
    )
  }

  /**
   * Record what local authentication this device has.
   *
   * A CLAIM by the client, stored as such. The biometric check happens on the handset, so
   * `BIOMETRIC_STRONG` reported from a rooted phone is worth what that device's integrity
   * signal says it is worth — which is why integrity is scored separately rather than trusted
   * through this field.
   */
  @Post(SECURITY_ROUTES.BIOMETRIC_ENROL)
  async enrolBiometric(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(EnrolBiometricSchema)) dto: EnrolBiometricDto,
  ) {
    const status = await this.pins.recordBiometric({
      userId: user.id,
      level: dto.level,
    })
    return ResponseBuilder.success(status, 'Biometric unlock is on')
  }

  // ── transparency ──────────────────────────────────────────────────────────
  /**
   * My recent security decisions, and why.
   *
   * Returns the DECISION and the plain-language reasons — never the numeric score, the
   * signal types or the weights. That omission is deliberate and it is a security
   * property, not coyness: a precise score turns this endpoint into a calibration
   * oracle, letting somebody tune inputs until the number drops below a threshold they
   * can observe. A person is owed an explanation of a decision about them; they are not
   * owed the detector's specification.
   */
  @Get(SECURITY_ROUTES.ASSESSMENTS)
  async myAssessments(@User() user: AuthenticatedUser) {
    const assessments = await this.risk.assessmentsForUser(user.id)
    return ResponseBuilder.success(assessments, 'Your recent security activity')
  }

  /**
   * My open holds, with a reference and an appeal route.
   *
   * The honest version of a held action: not a dead error, but "under review, usually
   * minutes", a reference somebody can quote to support, and a stated expectation. A
   * hold the user cannot see or ask about is indistinguishable from a bug.
   */
  @Get(SECURITY_ROUTES.HOLDS)
  async myHolds(@User() user: AuthenticatedUser) {
    const holds = await this.risk.holdsForUser(user.id)
    return ResponseBuilder.success(
      holds,
      holds.length === 0
        ? 'Nothing on your account is under review'
        : 'These actions are under review',
    )
  }
}

/**
 * The prompt that matches the factor actually issued.
 *
 * A module-level function rather than a private method because it is pure and has no business
 * touching `this` — and because the wrong string here is a support ticket, not a bug anyone can
 * see in a test. "Enter the code we sent you" shown above a PIN pad is exactly the confusion
 * that makes a user go looking for an SMS that will never arrive.
 *
 * The PIN copy names the app explicitly. A payment screen that says only "enter your PIN" is
 * indistinguishable from a phishing page asking for the UPI PIN, and the habit of typing a UPI
 * PIN wherever it is requested is the single most valuable habit an attacker can cultivate.
 */
function messageForMethod(method: StepUpMethod): string {
  switch (method) {
    case StepUpMethod.PIN_REAUTH:
      return 'Enter your Pravaah PIN to confirm'
    case StepUpMethod.BIOMETRIC:
      return 'Confirm with your fingerprint or face'
    default:
      return 'Enter the code we sent you'
  }
}
