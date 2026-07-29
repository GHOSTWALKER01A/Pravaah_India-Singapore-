import { z } from 'zod'

/**
 * M6 enums, mirrored from `schema.prisma`.
 *
 * Declared here rather than imported from the generated Prisma client for the
 * same reason every other module does it: this package is consumed by the RN app
 * and the admin console, and neither of those can (or should) depend on a
 * server-side database client to know what a risk decision looks like.
 */

export const RiskSubjectTypeSchema = z.enum([
  'TRANSACTION',
  'CLAIM',
  'LOGIN',
  'DEVICE_BIND',
  'CONSENT',
  'PAYOUT',
])
export type RiskSubjectTypeInput = z.infer<typeof RiskSubjectTypeSchema>

export const RiskDecisionSchema = z.enum([
  'ALLOW',
  'REVIEW',
  'STEP_UP',
  'HOLD',
  'BLOCK',
])
export type RiskDecisionInput = z.infer<typeof RiskDecisionSchema>

export const StepUpMethodSchema = z.enum(['OTP', 'BIOMETRIC', 'PIN_REAUTH'])
export type StepUpMethodInput = z.infer<typeof StepUpMethodSchema>

export const StepUpPurposeSchema = z.enum([
  'DEVICE_BIND',
  'DEVICE_RECOVERY',
  'TRANSACTION',
  'CLAIM',
  'LOGIN',
  'CONSENT',
])
export type StepUpPurposeInput = z.infer<typeof StepUpPurposeSchema>

export const DeviceStatusSchema = z.enum([
  'BINDING',
  'ACTIVE',
  'REVOKED',
  'SUSPECTED_SWAP',
])
export type DeviceStatusInput = z.infer<typeof DeviceStatusSchema>

/**
 * The app's own attestation verdict.
 *
 * `UNKNOWN` is a distinct value from `OK` and the distinction matters: a client
 * that did not run the check has not passed it. Treating a missing verdict as OK
 * is how an attacker opts out of integrity checking by simply omitting a field.
 */
export const DeviceIntegritySchema = z.enum([
  'OK',
  'ROOTED',
  'EMULATOR',
  'UNKNOWN',
])
export type DeviceIntegrityInput = z.infer<typeof DeviceIntegritySchema>

export const FraudCaseStatusSchema = z.enum([
  'OPEN',
  'INVESTIGATING',
  'INFO_REQUESTED',
  'CLEARED',
  'CONFIRMED_FRAUD',
  'ESCALATED',
])
export type FraudCaseStatusInput = z.infer<typeof FraudCaseStatusSchema>

export const FraudSeveritySchema = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
])
export type FraudSeverityInput = z.infer<typeof FraudSeveritySchema>

export const ListKindSchema = z.enum(['WATCH', 'BLOCK', 'MULE', 'SANCTIONS'])
export type ListKindInput = z.infer<typeof ListKindSchema>

export const ListEntityTypeSchema = z.enum([
  'USER',
  'DEVICE',
  'VPA',
  'BENEFICIARY',
  'IP',
  'MOBILE',
])
export type ListEntityTypeInput = z.infer<typeof ListEntityTypeSchema>

export const EntityLinkTypeSchema = z.enum([
  'SHARED_DEVICE',
  'SHARED_BENEFICIARY',
  'SHARED_VPA',
  'SHARED_IP',
])
export type EntityLinkTypeInput = z.infer<typeof EntityLinkTypeSchema>

/**
 * The outcomes an analyst may choose.
 *
 * A deliberate SUBSET of `FraudCaseStatus`: `OPEN`, `INVESTIGATING` and
 * `INFO_REQUESTED` are reached by workflow transitions (claiming a case, asking
 * the user something), not by a resolve call. Letting a resolve set them would
 * let an analyst "resolve" a case back into the queue and reset its SLA clock.
 */
export const FraudCaseOutcomeSchema = z.enum([
  'CLEARED',
  'CONFIRMED_FRAUD',
  'ESCALATED',
])
export type FraudCaseOutcomeInput = z.infer<typeof FraudCaseOutcomeSchema>
