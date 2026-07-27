import { z } from 'zod'

import { ReviewDecisionSchema } from '../schemas/kyc-enums.schema'

export const DecisionSchema = z.object({
  decision: ReviewDecisionSchema,
  notes: z.string().trim().min(3).max(500), // reason is mandatory
})
export type DecisionDto = z.infer<typeof DecisionSchema>
