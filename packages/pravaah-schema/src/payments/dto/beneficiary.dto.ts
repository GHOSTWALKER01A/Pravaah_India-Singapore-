import { z } from 'zod'

import {
  AccountNumberSchema,
  IfscSchema,
  VpaSchema,
} from '../schemas/money.schema'
import {
  BeneficiaryHandleTypeSchema,
  BeneficiaryStatusSchema,
} from '../schemas/payment-enums.schema'

/**
 * Resolve a UPI ID to the name its bank holds, WITHOUT moving money.
 *
 * The lookup exists so the payer sees who they are actually paying before they
 * commit. It is deliberately its own endpoint — a resolve folded into the
 * transfer call would arrive after the decision it is supposed to inform.
 */
export const ResolveVpaSchema = z.object({
  vpa: VpaSchema,
})
export type ResolveVpaDto = z.infer<typeof ResolveVpaSchema>

/**
 * Resolve a MOBILE NUMBER to a payable address.
 *
 * The number is the address people actually know — nobody has a friend's VPA memorised — so this is
 * the lookup behind the "to a phone number" destination.
 *
 * `country` is required and is never inferred from the digits. That is a correctness requirement, not
 * strictness for its own sake: `8123456789` is a valid Indian mobile and also a Singapore number with
 * a stray digit, and guessing wrong pays a stranger in the wrong country over an irreversible rail.
 * The client always asks.
 *
 * The number itself is validated in `phone.util.ts` rather than by a regex here, because the two
 * countries have genuinely different rules (10 digits starting 6–9 vs 8 digits starting 8–9) and the
 * error a user sees should say which country's rule their number failed.
 */
export const ResolveMobileSchema = z.object({
  /** As typed. Spaces, dashes, a leading `+` or country code are all tolerated. */
  phone: z.string().trim().min(6).max(24),
  country: z.enum(['IN', 'SG']),
})
export type ResolveMobileDto = z.infer<typeof ResolveMobileSchema>

/**
 * Add a beneficiary.
 *
 * A discriminated union rather than one object with everything optional, because
 * the two handle kinds are validated by different rules and a permissive shape
 * would accept `{ handleType: 'ACCOUNT_IFSC' }` with no account number at all —
 * a row that looks verified-able and can never be verified.
 */
const VpaBeneficiarySchema = z.object({
  handleType: z.literal('UPI_VPA'),
  vpa: VpaSchema,
  displayName: z.string().trim().min(1).max(80),
  /**
   * Marks the user's OWN address. Own-account moves skip the new-beneficiary
   * cooling period, so this is checked against the user's registered handles
   * server-side and never simply believed.
   */
  isSelf: z.boolean().default(false),
})

const AccountBeneficiarySchema = z.object({
  handleType: z.literal('ACCOUNT_IFSC'),
  accountNumber: AccountNumberSchema,
  ifsc: IfscSchema,
  displayName: z.string().trim().min(1).max(80),
  isSelf: z.boolean().default(false),
})

/**
 * A beneficiary reachable over the UPI↔PayNow linkage.
 *
 * Still a UPI ID, and that is the whole point of the linkage: the sender enters
 * the recipient's registered UPI ID, not a PayNow proxy or a bank account. The
 * separate variant exists because a cross-border credit additionally requires
 * sanctions screening and a declared country before it may be used.
 */
const PayNowBeneficiarySchema = z.object({
  handleType: z.literal('PAYNOW_UPI'),
  vpa: VpaSchema,
  displayName: z.string().trim().min(1).max(80),
  /** ISO-3166 alpha-2. The corridor's destination leg. */
  country: z.string().trim().length(2).toUpperCase(),
  isSelf: z.literal(false).default(false),
})

export const AddBeneficiarySchema = z.discriminatedUnion('handleType', [
  VpaBeneficiarySchema,
  AccountBeneficiarySchema,
  PayNowBeneficiarySchema,
])
export type AddBeneficiaryDto = z.infer<typeof AddBeneficiarySchema>

export const BeneficiaryListQuerySchema = z.object({
  status: BeneficiaryStatusSchema.optional(),
  handleType: BeneficiaryHandleTypeSchema.optional(),
  search: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type BeneficiaryListQueryDto = z.infer<typeof BeneficiaryListQuerySchema>

/**
 * Block a beneficiary.
 *
 * Distinct from deleting one, and the distinction is load-bearing: a blocked row
 * stays and keeps refusing payments, whereas a deleted row can be re-added in
 * seconds with a fresh cooling period. When a user says "this person scammed
 * me", block is the honest answer.
 */
export const BlockBeneficiarySchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
})
export type BlockBeneficiaryDto = z.infer<typeof BlockBeneficiarySchema>
