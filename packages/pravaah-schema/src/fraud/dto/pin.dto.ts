import { z } from 'zod'

/**
 * The transaction PIN — Pravaah's own knowledge factor.
 *
 * ## What this is NOT
 *
 * Not the UPI PIN. That is registered against the user's bank account, entered in NPCI's
 * Common Library, and validated by the issuing bank — Pravaah never sees it. This authorises
 * an instruction against the Pravaah wallet. Every user-facing string says so explicitly,
 * because a screen that asked for "your PIN" during a payment would be indistinguishable from
 * a phishing attempt for the one that matters.
 */

/**
 * Six digits, as a STRING.
 *
 * Never `z.number()`. `012345` is a valid PIN and a number would silently become `12345`,
 * locking that user out of their own account with no error anywhere — the same class of bug as
 * parsing money into a float. A string also keeps a leading-zero PIN comparable byte-for-byte
 * against its bcrypt hash.
 *
 * Strength is checked SERVER-SIDE (`isWeakPin`), not here. The rule list is a detector
 * specification, and shipping it to the client would tell an attacker exactly which patterns
 * survive — while a client-side check is trivially bypassed anyway.
 */
const PinSchema = z
  .string()
  .regex(/^\d{6}$/, 'Your PIN must be exactly 6 digits')

export const SetPinSchema = z.object({
  pin: PinSchema,
  /**
   * The device setting the PIN. REQUIRED, unlike most places it appears.
   *
   * The PIN is one half of a two-factor pair whose other half is the bound device, so the
   * server refuses to enrol one from a device it does not recognise. Optional here would mean
   * a caller could simply omit it and get the refusal as a confusing 403 instead of a
   * validation error naming the field.
   */
  deviceId: z.uuid(),
})
export type SetPinDto = z.infer<typeof SetPinSchema>

/**
 * Change a PIN the user already has.
 *
 * There is deliberately no `currentPin` field. The change is authorised by a BIOMETRIC — a
 * stronger factor than the PIN being replaced — so demanding both would add friction without
 * adding assurance: anybody who can pass the biometric can already authorise a payment.
 *
 * There is also no `biometricPassed: true` field, and that absence is the control. A boolean
 * on the wire is not proof of anything. The server establishes the biometric from a verified
 * step-up challenge, so a client cannot assert its way past it.
 */
export const ChangePinSchema = z.object({
  newPin: PinSchema,
  /** The nonce of the biometric challenge issued for this change. */
  nonce: z.uuid(),
  /**
   * The secret the challenge handed the app, echoed back after a successful local biometric.
   *
   * This is what makes the nonce proof rather than an assertion: the app can only produce it if
   * it received it AND the OS reported a passing fingerprint or face check. Consumed once —
   * `StepUpService.verify` marks the challenge PASSED, so one biometric authorises exactly one
   * change.
   */
  assertion: z.string().trim().min(1).max(512),
})
export type ChangePinDto = z.infer<typeof ChangePinSchema>

/**
 * Reset a forgotten or locked PIN.
 *
 * Proved by an SMS OTP, and it costs a 24-hour device cooling-off — because a reset proved
 * only by SMS would otherwise be a bypass of the PIN itself: somebody holding the unlocked
 * phone reads the code, resets, and pays. The cooling-off means high-value transfers stay
 * under the risk ladder for a day afterward, so "reset and drain" becomes "reset and wait
 * while somebody reviews it".
 */
export const ResetPinSchema = z.object({
  newPin: PinSchema,
  /** The nonce of the SMS challenge issued for this reset. */
  nonce: z.uuid(),
  answer: z.string().trim().min(1).max(512),
})
export type ResetPinDto = z.infer<typeof ResetPinSchema>

/** Answer a PIN challenge on an action. */
export const VerifyPinSchema = z.object({
  pin: PinSchema,
})
export type VerifyPinDto = z.infer<typeof VerifyPinSchema>

/**
 * What the OS reported about this device's local authentication.
 *
 * Recorded as a CLAIM, never as proof — the biometric check happens on the handset, so
 * `BIOMETRIC_STRONG` from a rooted device is worth what that device's integrity signal says it
 * is worth. It is stored so the console can see whether an account has a real second factor.
 */
export const BiometricLevelSchema = z.enum([
  'NONE',
  'SECRET',
  'BIOMETRIC_WEAK',
  'BIOMETRIC_STRONG',
])
export type BiometricLevelInput = z.infer<typeof BiometricLevelSchema>

export const EnrolBiometricSchema = z.object({
  level: BiometricLevelSchema,
})
export type EnrolBiometricDto = z.infer<typeof EnrolBiometricSchema>
