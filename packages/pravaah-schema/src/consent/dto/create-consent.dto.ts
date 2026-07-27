import { z } from 'zod'

import {
  DataLifeUnitSchema,
  FetchTypeSchema,
  FiTypeSchema,
  FrequencyUnitSchema,
} from '../schemas/consent-enums.schema'

/** ISO-8601 date/datetime string (e.g. "2024-01-01" or full timestamp). */
const IsoDate = z.iso.datetime({ offset: true }).or(z.iso.date())

const DataRangeSchema = z
  .object({
    from: IsoDate,
    to: IsoDate,
  })
  .refine((r) => new Date(r.from) < new Date(r.to), {
    message: 'dataRange.from must be before dataRange.to',
    path: ['from'],
  })
  .refine((r) => new Date(r.to) <= new Date(), {
    message: 'dataRange.to cannot be in the future',
    path: ['to'],
  })

const DataLifeSchema = z.object({
  unit: DataLifeUnitSchema,
  value: z.number().int().min(1).max(120),
})

const FrequencySchema = z.object({
  unit: FrequencyUnitSchema,
  value: z.number().int().min(1).max(31),
})

/**
 * Body for `POST /consent/create`. The purpose + purposeCode are declared here
 * and travel with every downstream data row (purpose limitation). A PERIODIC
 * fetchType requires a frequency.
 */
export const CreateConsentSchema = z
  .object({
    fiTypes: z.array(FiTypeSchema).min(1, 'At least one FI type is required'),
    purpose: z.string().trim().min(3).max(200),
    // AA purpose code, e.g. "101" (spending patterns), "103" (monitoring).
    purposeCode: z
      .string()
      .trim()
      .regex(/^\d{3}$/, 'purposeCode must be a 3-digit AA code'),
    fetchType: FetchTypeSchema,
    frequency: FrequencySchema.optional(),
    dataRange: DataRangeSchema,
    dataLife: DataLifeSchema,
    // Deep link the AA (or the sandbox screen) redirects to after the user
    // approves/rejects, so the in-app browser auto-closes and returns to the
    // app. Must be an absolute URL / app deep link. Falls back to APP_DEEPLINK.
    redirectUrl: z
      .string()
      .trim()
      .max(512)
      .regex(
        /^[a-z][a-z0-9+.-]*:\/\//i,
        'redirectUrl must be an absolute URL or app deep link',
      )
      .optional(),
  })
  .refine((v) => v.fetchType !== 'PERIODIC' || !!v.frequency, {
    message: 'frequency is required for a PERIODIC consent',
    path: ['frequency'],
  })
export type CreateConsentDto = z.infer<typeof CreateConsentSchema>

/** Body for the dev mock-AA consent screen decision (`POST /mock/aa/:id`). */
export const MockAaDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
})
export type MockAaDecisionDto = z.infer<typeof MockAaDecisionSchema>
