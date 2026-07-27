import { z } from 'zod'

export const ScreenSanctionsSchema = z.object({
  name: z.string().trim().min(1).optional(),
})
export type ScreenSanctionsDto = z.infer<typeof ScreenSanctionsSchema>
