import { z } from 'zod'

export const OkycCallbackSchema = z.object({
  providerRefId: z.string().min(1),
  status: z.string().optional(),
})
export type OkycCallbackDto = z.infer<typeof OkycCallbackSchema>
