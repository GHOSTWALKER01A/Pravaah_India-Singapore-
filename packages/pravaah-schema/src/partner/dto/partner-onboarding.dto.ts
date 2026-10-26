import { z } from 'zod'

import { DisclosableClaimSchema } from '../../passport/schemas/claims.schema'
import { PartnerTypeSchema } from '../schemas/partner-enums.schema'

/**
 * A bare, lowercase DNS hostname — `lender.example.sg`, never a URL. It is what
 * the holder reads on the consent screen, so a scheme, path or port would only be
 * room for a lookalike to hide in.
 */
export const PartnerDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'domain must be a bare hostname such as "lender.example.sg"',
  )

/**
 * A webhook endpoint. HTTPS only — a callback carries the partner's verification
 * outcomes, and plain HTTP would hand them to anyone on the path. Loopback HTTP is
 * accepted so a partner can develop locally; the server refuses it in production
 * and also refuses private-network targets at delivery time (SSRF).
 */
export const WebhookUrlSchema = z
  .url()
  .max(500)
  .refine(
    (value) => {
      try {
        const url = new URL(value)
        if (url.username || url.password) return false
        if (url.protocol === 'https:') return true
        return (
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
      } catch {
        return false
      }
    },
    'webhookUrl must be an https:// URL without embedded credentials',
  )

/** ISO 3166-1 alpha-2, upper-cased. */
export const CountryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .transform((c) => c.toUpperCase())

/**
 * Body for `POST /partners/apply` — a relying party asking to join.
 *
 * The application states what it WANTS (`requestedScopes`, `useCase`); an admin
 * decides what it GETS at approval. Nothing an applicant writes here grants
 * anything — a partner is inert until approved, and its scopes are the admin's.
 */
export const ApplyPartnerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: PartnerTypeSchema,
  domain: PartnerDomainSchema,
  country: CountryCodeSchema,
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.email().max(200).transform((e) => e.toLowerCase()),
  /** E.164. Used to match the contact's OTP login to their console account. */
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'contactPhone must be E.164, e.g. +6591234567')
    .optional(),
  requestedScopes: z.array(DisclosableClaimSchema).min(1).max(32),
  /** Why they need what they asked for. Read by the admin who approves. */
  useCase: z.string().trim().min(20).max(2000),
  webhookUrl: WebhookUrlSchema.optional(),
})
export type ApplyPartnerDto = z.infer<typeof ApplyPartnerSchema>
