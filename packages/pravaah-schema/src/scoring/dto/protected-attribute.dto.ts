import { z } from 'zod'

/**
 * Body for `POST /score/fairness-consent`.
 *
 * Protected attributes exist for ONE purpose: proving the model treats groups
 * equitably. They are collected under an explicit, separate consent, stored
 * field-encrypted, and are never part of a feature vector. `consentGiven:false`
 * is a withdrawal — the stored attributes are cleared.
 *
 * Free text is deliberately not accepted: a closed vocabulary keeps groups large
 * enough to be statistically meaningful and keeps the store from becoming a
 * second identity database.
 */
export const AGE_BANDS = [
  '18-25',
  '26-35',
  '36-45',
  '46-60',
  '60+',
] as const

export const GENDERS = [
  'female',
  'male',
  'other',
  'prefer_not_to_say',
] as const

export const FairnessConsentSchema = z
  .object({
    consentGiven: z.boolean(),
    gender: z.enum(GENDERS).optional(),
    ageBand: z.enum(AGE_BANDS).optional(),
    /** ISO 3166-1 alpha-2, e.g. "IN", "SG". */
    nationality: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'nationality must be an ISO 3166-1 alpha-2 code')
      .optional(),
  })
  .refine(
    (v) =>
      !v.consentGiven || !!(v.gender ?? v.ageBand ?? v.nationality),
    {
      message: 'Provide at least one attribute when granting fairness consent',
      path: ['consentGiven'],
    },
  )
export type FairnessConsentDto = z.infer<typeof FairnessConsentSchema>
