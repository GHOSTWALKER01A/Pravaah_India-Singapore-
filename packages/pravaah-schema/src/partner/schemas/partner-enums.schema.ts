import { z } from 'zod'

/**
 * M7 · Partner Console enums. Each mirrors a Prisma enum so the partner web
 * console, the RN wallet's "who has seen my passport" screen and the backend
 * validate against one source of truth.
 */

/** What kind of relying party this is. Shown on the holder's consent screen. */
export const PARTNER_TYPE = {
  LENDER: 'LENDER',
  INSURER: 'INSURER',
  EMPLOYER: 'EMPLOYER',
  LANDLORD: 'LANDLORD',
  BANK: 'BANK',
  OTHER: 'OTHER',
} as const

export const PartnerTypeSchema = z.enum([
  PARTNER_TYPE.LENDER,
  PARTNER_TYPE.INSURER,
  PARTNER_TYPE.EMPLOYER,
  PARTNER_TYPE.LANDLORD,
  PARTNER_TYPE.BANK,
  PARTNER_TYPE.OTHER,
])
export type PartnerTypeInput = z.infer<typeof PartnerTypeSchema>

/**
 * Partner lifecycle.
 *
 *   PENDING_APPROVAL  applied, not yet vetted — can sign in, cannot verify
 *   ACTIVE            approved; scopes and trust level fixed by an admin
 *   SUSPENDED         reversible hold (abuse, non-payment, investigation)
 *   REVOKED           terminal; every key dies with it
 */
export const PARTNER_STATUS = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
} as const

export const PartnerStatusSchema = z.enum([
  PARTNER_STATUS.PENDING_APPROVAL,
  PARTNER_STATUS.ACTIVE,
  PARTNER_STATUS.SUSPENDED,
  PARTNER_STATUS.REVOKED,
])
export type PartnerStatusInput = z.infer<typeof PartnerStatusSchema>

export const PARTNER_TRUST_LEVEL = {
  STANDARD: 'STANDARD',
  HIGH: 'HIGH',
} as const

export const PartnerTrustLevelSchema = z.enum([
  PARTNER_TRUST_LEVEL.STANDARD,
  PARTNER_TRUST_LEVEL.HIGH,
])
export type PartnerTrustLevelInput = z.infer<typeof PartnerTrustLevelSchema>

/**
 * Console roles, least to most privileged.
 *
 *   PARTNER_VIEWER   read verifications, usage, templates
 *   PARTNER_ANALYST  + open verifications and record decisions
 *   PARTNER_ADMIN    + keys, webhooks, templates, team
 */
export const PARTNER_ROLE = {
  PARTNER_VIEWER: 'PARTNER_VIEWER',
  PARTNER_ANALYST: 'PARTNER_ANALYST',
  PARTNER_ADMIN: 'PARTNER_ADMIN',
} as const

export const PartnerRoleSchema = z.enum([
  PARTNER_ROLE.PARTNER_VIEWER,
  PARTNER_ROLE.PARTNER_ANALYST,
  PARTNER_ROLE.PARTNER_ADMIN,
])
export type PartnerRoleInput = z.infer<typeof PartnerRoleSchema>

export const PARTNER_API_KEY_STATUS = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const

export const PartnerApiKeyStatusSchema = z.enum([
  PARTNER_API_KEY_STATUS.ACTIVE,
  PARTNER_API_KEY_STATUS.REVOKED,
])

/** The partner's own underwriting outcome. `REFERRED` is not final. */
export const PARTNER_DECISION = {
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  REFERRED: 'REFERRED',
} as const

export const PartnerDecisionTypeSchema = z.enum([
  PARTNER_DECISION.APPROVED,
  PARTNER_DECISION.DECLINED,
  PARTNER_DECISION.REFERRED,
])
export type PartnerDecisionTypeInput = z.infer<typeof PartnerDecisionTypeSchema>

export const CONSENT_RECEIPT_STATUS = {
  ACTIVE: 'ACTIVE',
  WITHDRAWN: 'WITHDRAWN',
  EXPIRED: 'EXPIRED',
} as const

export const ConsentReceiptStatusSchema = z.enum([
  CONSENT_RECEIPT_STATUS.ACTIVE,
  CONSENT_RECEIPT_STATUS.WITHDRAWN,
  CONSENT_RECEIPT_STATUS.EXPIRED,
])

export const WEBHOOK_DELIVERY_STATUS = {
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
  DEAD: 'DEAD',
} as const

export const WebhookDeliveryStatusSchema = z.enum([
  WEBHOOK_DELIVERY_STATUS.PENDING,
  WEBHOOK_DELIVERY_STATUS.DELIVERED,
  WEBHOOK_DELIVERY_STATUS.DEAD,
])

export const PARTNER_USAGE_KIND = {
  REQUEST_CREATED: 'REQUEST_CREATED',
  VERIFIED: 'VERIFIED',
  PRESENTATION_REJECTED: 'PRESENTATION_REJECTED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  DIRECT_VERIFIED: 'DIRECT_VERIFIED',
  DIRECT_REJECTED: 'DIRECT_REJECTED',
} as const

export type PartnerUsageKindValue =
  (typeof PARTNER_USAGE_KIND)[keyof typeof PARTNER_USAGE_KIND]

/**
 * Outbound webhook event types. A partner subscribes to all of them; the payload
 * never carries a claim VALUE — only names, statuses and predicate booleans. The
 * values are fetched over the authenticated API, so a leaked webhook log is not a
 * leaked credit file.
 */
export const PARTNER_WEBHOOK_EVENT = {
  VERIFICATION_APPROVED: 'verification.approved',
  VERIFICATION_DECLINED: 'verification.declined',
  VERIFICATION_EXPIRED: 'verification.expired',
  VERIFICATION_CANCELLED: 'verification.cancelled',
  VERIFICATION_PRESENTATION_REJECTED: 'verification.presentation_rejected',
  CONSENT_WITHDRAWN: 'consent.withdrawn',
  PARTNER_STATUS_CHANGED: 'partner.status_changed',
  TEST: 'webhook.test',
} as const

export type PartnerWebhookEventType =
  (typeof PARTNER_WEBHOOK_EVENT)[keyof typeof PARTNER_WEBHOOK_EVENT]

/**
 * Wire contract for webhook signatures, published here so a partner SDK and our
 * dispatcher cannot disagree. The signature is
 * `hex(HMAC-SHA256(secret, "${timestamp}.${rawBody}"))` — the same scheme our own
 * inbound webhooks verify, so there is exactly one signing convention in the
 * product.
 */
export const PARTNER_WEBHOOK_HEADERS = {
  SIGNATURE: 'x-pravaah-signature',
  TIMESTAMP: 'x-pravaah-timestamp',
  EVENT_ID: 'x-pravaah-event-id',
  EVENT_TYPE: 'x-pravaah-event-type',
} as const

/**
 * API key wire format: `pvk_live_<48 base64url chars>`. The `pvk_` family prefix
 * matches M3's bootstrap keys so secret scanners catch both.
 */
export const PARTNER_API_KEY_PREFIX = 'pvk_live_'
