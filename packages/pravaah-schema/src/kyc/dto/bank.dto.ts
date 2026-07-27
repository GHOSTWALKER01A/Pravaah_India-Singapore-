import { z } from 'zod'

/** Card validity (expiry) in MM/YY, e.g. "07/29". */
const CARD_VALIDITY_REGEX = /^(0[1-9]|1[0-2])\/\d{2}$/

export const PennyDropSchema = z.object({
  account: z.string().regex(/^\d{9,18}$/, 'Invalid account number'),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  // Debit/credit card validity in MM/YY. Must be a valid month and not expired
  // (a card is valid through the last day of its printed month).
  cardValidity: z
    .string()
    .trim()
    .regex(CARD_VALIDITY_REGEX, 'Invalid card validity (MM/YY)')
    .refine((v) => {
      const [mm, yy] = v.split('/')
      const endOfMonth = new Date(2000 + Number(yy), Number(mm), 0, 23, 59, 59, 999)
      return endOfMonth.getTime() >= Date.now()
    }, 'Card has expired'),
})
export type PennyDropDto = z.infer<typeof PennyDropSchema>
