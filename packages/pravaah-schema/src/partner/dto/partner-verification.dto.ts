import { z } from 'zod'

import {
  DisclosableClaimSchema,
  PresentationTemplateIdSchema,
} from '../../passport/schemas/claims.schema'
import {
  PresentationChannelSchema,
  VerifierRequestStatusSchema,
} from '../../passport/schemas/passport-enums.schema'
import { PartnerDecisionTypeSchema } from '../schemas/partner-enums.schema'
import { PredicateSpecSchema } from '../schemas/predicate.schema'

/** A partner's own reference, echoed back in every webhook for that request. */
export const ExternalRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:/-]+$/, 'externalRef has unsupported characters')

/**
 * Body for `POST /partner/verifications` (API key) and
 * `POST /partner-console/verifications` (console user).
 *
 * Four ways to say WHAT is wanted, combinable: a catalogue `template`, one of the
 * partner's own saved templates (`templateId`), an explicit `requestedClaims`
 * list, and `predicates`. Predicates compile to threshold claims server-side and
 * are merged in — so "band ≥ GOOD" costs the holder one boolean, not the band.
 *
 * WHO is asked is optional. With a `pravaahId` or `cardRef` the request lands in
 * that holder's inbox; with neither it is an open request the partner shows as a
 * QR, claimed by the first holder to scan it (the OpenID4VP cross-device flow).
 */
export const CreatePartnerVerificationSchema = z
  .object({
    template: PresentationTemplateIdSchema.optional(),
    templateId: z.uuid().optional(),
    requestedClaims: z.array(DisclosableClaimSchema).max(32).optional(),
    predicates: z.array(PredicateSpecSchema).max(8).optional(),
    /** Shown verbatim to the holder. Required unless a template supplies one. */
    purpose: z.string().trim().min(5).max(300).optional(),
    pravaahId: z.string().trim().max(24).optional(),
    cardRef: z.string().trim().min(8).max(64).optional(),
    externalRef: ExternalRefSchema.optional(),
    channel: PresentationChannelSchema.default('QR'),
    ttlSeconds: z.number().int().min(30).max(900).default(300),
  })
  .refine(
    (v) =>
      !!v.template ||
      !!v.templateId ||
      (v.requestedClaims?.length ?? 0) > 0 ||
      (v.predicates?.length ?? 0) > 0,
    {
      message:
        'Say what you need: a `template`, a `templateId`, `requestedClaims` or `predicates`',
      path: ['requestedClaims'],
    },
  )
  .refine((v) => !(v.template && v.templateId), {
    message: 'Use either a catalogue `template` or your own `templateId`, not both',
    path: ['templateId'],
  })
  .refine((v) => !!v.template || !!v.templateId || !!v.purpose, {
    message: 'A request without a template needs a `purpose` — the holder must be told why',
    path: ['purpose'],
  })
  .refine((v) => !(v.pravaahId && v.cardRef), {
    message: 'Identify the holder by `pravaahId` OR `cardRef`, not both',
    path: ['cardRef'],
  })
export type CreatePartnerVerificationDto = z.infer<
  typeof CreatePartnerVerificationSchema
>

/** Query for the partner's verification list. */
export const PartnerVerificationListQuerySchema = z.object({
  status: VerifierRequestStatusSchema.optional(),
  externalRef: ExternalRefSchema.optional(),
  decision: PartnerDecisionTypeSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PartnerVerificationListQueryDto = z.infer<
  typeof PartnerVerificationListQuerySchema
>

/**
 * Body for recording the partner's underwriting outcome.
 *
 * `metadata` is capped at 4 KB serialised. It is the partner's free-form
 * annotation (a loan id, an offer amount); an unbounded JSON column on an
 * API-key-authenticated route is a storage-exhaustion vector.
 */
export const PartnerDecisionSchema = z.object({
  decision: PartnerDecisionTypeSchema,
  reasonCode: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'reasonCode must be UPPER_SNAKE_CASE')
    .optional(),
  reason: z.string().trim().max(1000).optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => JSON.stringify(m).length <= 4096, {
      message: 'metadata must serialise to 4 KB or less',
    })
    .optional(),
})
export type PartnerDecisionDto = z.infer<typeof PartnerDecisionSchema>

/** Body for cancelling a still-pending request. */
export const CancelPartnerVerificationSchema = z.object({
  reason: z.string().trim().max(300).optional(),
})
export type CancelPartnerVerificationDto = z.infer<
  typeof CancelPartnerVerificationSchema
>

/**
 * Body for `POST /partner/presentations/verify` — a presentation handed to the
 * partner directly (their own wallet integration, or an OpenID4VP `direct_post`
 * they received). The combined SD-JWT VC wire format only; the pre-split form is
 * M3's `/verify` and stays there.
 */
export const PartnerDirectVerifySchema = z.object({
  presentation: z.string().trim().min(20).max(65536),
  /** The nonce this partner issued. Required: M7 does not do replayable checks. */
  expectedNonce: z.string().trim().min(16).max(256),
  requiredClaims: z.array(DisclosableClaimSchema).max(32).optional(),
  predicates: z.array(PredicateSpecSchema).max(8).optional(),
  externalRef: ExternalRefSchema.optional(),
})
export type PartnerDirectVerifyDto = z.infer<typeof PartnerDirectVerifySchema>
