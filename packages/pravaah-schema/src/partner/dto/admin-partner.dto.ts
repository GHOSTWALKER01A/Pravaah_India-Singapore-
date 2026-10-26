import { z } from 'zod'

import { DisclosableClaimSchema } from '../../passport/schemas/claims.schema'
import {
  PartnerStatusSchema,
  PartnerTrustLevelSchema,
  PartnerTypeSchema,
} from '../schemas/partner-enums.schema'
import { CountryCodeSchema } from './partner-onboarding.dto'

export const AdminPartnerListQuerySchema = z.object({
  status: PartnerStatusSchema.optional(),
  type: PartnerTypeSchema.optional(),
  /** Case-insensitive match on name, domain or audience. */
  q: z.string().trim().min(2).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type AdminPartnerListQueryDto = z.infer<typeof AdminPartnerListQuerySchema>

/**
 * Approve an applicant.
 *
 * This is the moment a partner's reach is decided: `allowedScopes` is the ceiling
 * on every request it will ever make, enforced server-side on every call. There is
 * no `adminId` field — the approver is the authenticated admin, never a body value.
 */
export const ApprovePartnerSchema = z.object({
  allowedScopes: z.array(DisclosableClaimSchema).min(1).max(32),
  trustLevel: PartnerTrustLevelSchema.default('STANDARD'),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  note: z.string().trim().max(500).optional(),
})
export type ApprovePartnerDto = z.infer<typeof ApprovePartnerSchema>

/** Reject / suspend / reinstate / revoke. The reason is the only record of why. */
export const PartnerStatusChangeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'Give a real reason — at least 10 characters')
    .max(500),
})
export type PartnerStatusChangeDto = z.infer<typeof PartnerStatusChangeSchema>

/** Adjust an ACTIVE partner's policy without re-approval. */
export const UpdatePartnerPolicySchema = z
  .object({
    allowedScopes: z.array(DisclosableClaimSchema).min(1).max(32).optional(),
    trustLevel: PartnerTrustLevelSchema.optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .refine(
    (v) =>
      v.allowedScopes !== undefined ||
      v.trustLevel !== undefined ||
      v.retentionDays !== undefined,
    { message: 'Nothing to update' },
  )
export type UpdatePartnerPolicyDto = z.infer<typeof UpdatePartnerPolicySchema>

// ── trust registry ──────────────────────────────────────────────────────────
export const TrustRegistryEntrySchema = z.object({
  issuerDid: z
    .string()
    .trim()
    .max(300)
    .regex(/^did:(web|key):[A-Za-z0-9._:%-]+$/, 'issuerDid must be a did:web or did:key'),
  issuerName: z.string().trim().min(2).max(120),
  country: CountryCodeSchema,
  jwksUri: z.url().max(500).startsWith('https://').optional(),
  note: z.string().trim().max(500).optional(),
})
export type TrustRegistryEntryDto = z.infer<typeof TrustRegistryEntrySchema>

export const UpdateTrustRegistryEntrySchema = z
  .object({
    accepted: z.boolean().optional(),
    jwksUri: z.url().max(500).startsWith('https://').nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'Nothing to update',
  })
export type UpdateTrustRegistryEntryDto = z.infer<
  typeof UpdateTrustRegistryEntrySchema
>
