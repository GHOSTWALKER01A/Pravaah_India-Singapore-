import { z } from 'zod'

import { DisclosableClaimSchema } from '../../passport/schemas/claims.schema'
import {
  PartnerRoleSchema,
  WebhookDeliveryStatusSchema,
} from '../schemas/partner-enums.schema'
import { PredicateSpecSchema } from '../schemas/predicate.schema'
import { WebhookUrlSchema } from './partner-onboarding.dto'

// ── API keys ────────────────────────────────────────────────────────────────
/**
 * Issue a key. `scopes` must be a subset of the partner's approved scopes — the
 * server checks, and re-checks on every request, so narrowing a partner narrows
 * every key it holds.
 */
export const IssuePartnerApiKeySchema = z.object({
  label: z.string().trim().min(2).max(60),
  scopes: z.array(DisclosableClaimSchema).min(1).max(32),
  rateLimitPerMin: z.number().int().min(1).max(600).default(60),
  /** Optional hard expiry. Omitted = until revoked. */
  expiresInDays: z.number().int().min(1).max(730).optional(),
})
export type IssuePartnerApiKeyDto = z.infer<typeof IssuePartnerApiKeySchema>

/**
 * Rotate a key: mint a replacement with the same scopes, and keep the old one
 * working for `graceHours` so the partner can deploy without downtime. `0` kills
 * the old key immediately — the right answer when it leaked.
 */
export const RotatePartnerApiKeySchema = z.object({
  graceHours: z.number().int().min(0).max(168).default(24),
})
export type RotatePartnerApiKeyDto = z.infer<typeof RotatePartnerApiKeySchema>

export const RevokePartnerApiKeySchema = z.object({
  reason: z.string().trim().min(3).max(300),
})
export type RevokePartnerApiKeyDto = z.infer<typeof RevokePartnerApiKeySchema>

// ── profile + webhooks ──────────────────────────────────────────────────────
/**
 * What a partner may change about itself. Deliberately NOT the name, domain,
 * scopes, trust level or retention: those are what the holder is shown and what
 * an admin approved, and changing them is a re-approval, not a settings toggle.
 */
export const UpdatePartnerProfileSchema = z
  .object({
    /** `null` removes the webhook. */
    webhookUrl: WebhookUrlSchema.nullable().optional(),
    contactEmail: z.email().max(200).optional(),
  })
  .refine((v) => v.webhookUrl !== undefined || v.contactEmail !== undefined, {
    message: 'Nothing to update',
  })
export type UpdatePartnerProfileDto = z.infer<typeof UpdatePartnerProfileSchema>

export const WebhookDeliveryQuerySchema = z.object({
  status: WebhookDeliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})
export type WebhookDeliveryQueryDto = z.infer<typeof WebhookDeliveryQuerySchema>

// ── team ────────────────────────────────────────────────────────────────────
/**
 * Invite a colleague. They sign in with the ordinary OTP login; this row is what
 * authorises that login for the console. Phone is how the OTP session is matched,
 * so a user without one can only be matched by email.
 */
export const InvitePartnerUserSchema = z.object({
  email: z.email().max(200).transform((e) => e.toLowerCase()),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164, e.g. +6591234567')
    .optional(),
  name: z.string().trim().min(2).max(120).optional(),
  role: PartnerRoleSchema.default('PARTNER_VIEWER'),
})
export type InvitePartnerUserDto = z.infer<typeof InvitePartnerUserSchema>

export const UpdatePartnerUserSchema = z
  .object({
    role: PartnerRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    message: 'Nothing to update',
  })
export type UpdatePartnerUserDto = z.infer<typeof UpdatePartnerUserSchema>

// ── templates ───────────────────────────────────────────────────────────────
const templateBody = {
  name: z.string().trim().min(2).max(80),
  purpose: z.string().trim().min(5).max(300),
  claims: z.array(DisclosableClaimSchema).max(32).default([]),
  predicates: z.array(PredicateSpecSchema).max(8).default([]),
}

export const CreatePartnerTemplateSchema = z
  .object(templateBody)
  .refine((v) => v.claims.length + v.predicates.length > 0, {
    message: 'A template must ask for at least one claim or predicate',
    path: ['claims'],
  })
export type CreatePartnerTemplateDto = z.infer<typeof CreatePartnerTemplateSchema>

export const UpdatePartnerTemplateSchema = z
  .object({
    name: templateBody.name.optional(),
    purpose: templateBody.purpose.optional(),
    claims: z.array(DisclosableClaimSchema).max(32).optional(),
    predicates: z.array(PredicateSpecSchema).max(8).optional(),
    isArchived: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'Nothing to update',
  })
export type UpdatePartnerTemplateDto = z.infer<typeof UpdatePartnerTemplateSchema>

// ── usage ───────────────────────────────────────────────────────────────────
/** `YYYY-MM`, UTC. */
export const BillingPeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM')

export const PartnerUsageQuerySchema = z.object({
  /** Defaults to the current period. */
  period: BillingPeriodSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PartnerUsageQueryDto = z.infer<typeof PartnerUsageQuerySchema>
