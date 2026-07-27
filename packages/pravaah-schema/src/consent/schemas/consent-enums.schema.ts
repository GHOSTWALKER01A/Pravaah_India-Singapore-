import { z } from 'zod'

/**
 * M1 · Account Aggregator consent enums. Each mirrors a Prisma enum so the RN
 * app, admin console, and backend validate against one source of truth.
 */

/** FI types PRAVAAH can request. Scoring (M2) is designed around DEPOSIT + GSTR. */
export const FI_TYPE = {
  DEPOSIT: 'DEPOSIT',
  TERM_DEPOSIT: 'TERM_DEPOSIT',
  RECURRING_DEPOSIT: 'RECURRING_DEPOSIT',
  MUTUAL_FUNDS: 'MUTUAL_FUNDS',
  EQUITIES: 'EQUITIES',
  GSTR: 'GSTR',
} as const

export const FiTypeSchema = z.enum([
  FI_TYPE.DEPOSIT,
  FI_TYPE.TERM_DEPOSIT,
  FI_TYPE.RECURRING_DEPOSIT,
  FI_TYPE.MUTUAL_FUNDS,
  FI_TYPE.EQUITIES,
  FI_TYPE.GSTR,
])
export type FiTypeInput = z.infer<typeof FiTypeSchema>

/** ONETIME (score now) or PERIODIC (ongoing monitoring). */
export const FETCH_TYPE = {
  ONETIME: 'ONETIME',
  PERIODIC: 'PERIODIC',
} as const

export const FetchTypeSchema = z.enum([
  FETCH_TYPE.ONETIME,
  FETCH_TYPE.PERIODIC,
])
export type FetchTypeInput = z.infer<typeof FetchTypeSchema>

/** Data-life retention unit. INF is bounded to a sane ceiling server-side. */
export const DATA_LIFE_UNIT = {
  MONTH: 'MONTH',
  YEAR: 'YEAR',
  INF: 'INF',
} as const

export const DataLifeUnitSchema = z.enum([
  DATA_LIFE_UNIT.MONTH,
  DATA_LIFE_UNIT.YEAR,
  DATA_LIFE_UNIT.INF,
])
export type DataLifeUnitInput = z.infer<typeof DataLifeUnitSchema>

/** Frequency unit for PERIODIC consents. */
export const FREQUENCY_UNIT = {
  DAY: 'DAY',
  MONTH: 'MONTH',
} as const

export const FrequencyUnitSchema = z.enum([
  FREQUENCY_UNIT.DAY,
  FREQUENCY_UNIT.MONTH,
])
export type FrequencyUnitInput = z.infer<typeof FrequencyUnitSchema>

/** Consent lifecycle status. Mirrors the Prisma `ConsentStatus` enum. */
export const CONSENT_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  REJECTED: 'REJECTED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
} as const

export const ConsentStatusSchema = z.enum([
  CONSENT_STATUS.PENDING,
  CONSENT_STATUS.ACTIVE,
  CONSENT_STATUS.PAUSED,
  CONSENT_STATUS.REJECTED,
  CONSENT_STATUS.REVOKED,
  CONSENT_STATUS.EXPIRED,
  CONSENT_STATUS.FAILED,
])
export type ConsentStatusInput = z.infer<typeof ConsentStatusSchema>
