import { z } from 'zod'

import { CredentialStatusSchema } from '../schemas/passport-enums.schema'

/**
 * Body for `POST /admin/passport/:id/revoke`. Revoking kills a live credential
 * everywhere at once, so the reason is mandatory and substantive — it is the only
 * record of why someone's passport stopped working.
 */
export const AdminRevokeCredentialSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(20, 'Give a real reason — at least 20 characters')
    .max(500),
})
export type AdminRevokeCredentialDto = z.infer<
  typeof AdminRevokeCredentialSchema
>

/**
 * Body for `POST /admin/passport/:id/suspend`. A suspension is reversible and
 * flips the same status-list bit as a revocation — the difference is ours, not the
 * verifier's. To a verifier both read "do not accept", which is the correct
 * fail-closed behaviour while an investigation is open.
 */
export const AdminSuspendCredentialSchema = z.object({
  reason: z.string().trim().min(20).max(500),
})
export type AdminSuspendCredentialDto = z.infer<
  typeof AdminSuspendCredentialSchema
>

/** Query for `GET /admin/passport`. */
export const CredentialListQuerySchema = z.object({
  status: CredentialStatusSchema.optional(),
  /** Filter to credentials bound to a real passport (the international tier). */
  passportBound: z.stringbool().optional(),
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type CredentialListQueryDto = z.infer<typeof CredentialListQuerySchema>

/**
 * Body for `POST /admin/passport/partners` — registering a verifier.
 *
 * `audience` is the identifier that must appear in every KB-JWT presented to this
 * partner. It is theirs alone and immutable: it is what stops a presentation
 * captured by one lender being replayed at another.
 */
export const RegisterPartnerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  audience: z
    .string()
    .trim()
    .min(4)
    .max(200)
    .regex(
      /^[a-z0-9][a-z0-9._:-]*$/,
      'audience must be a lowercase slug or URI (e.g. "acme-bank" or "https://acme.example")',
    ),
  contactEmail: z.email().max(200).optional(),
  /** ISO 3166-1 alpha-2 of where the verifier operates. Audit context only. */
  country: z
    .string()
    .trim()
    .length(2)
    .transform((c) => c.toUpperCase())
    .optional(),
})
export type RegisterPartnerDto = z.infer<typeof RegisterPartnerSchema>
