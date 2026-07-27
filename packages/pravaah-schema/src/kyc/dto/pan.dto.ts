import { z } from 'zod'

export const VerifyPanSchema = z.object({
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN'),
})
export type VerifyPanDto = z.infer<typeof VerifyPanSchema>
