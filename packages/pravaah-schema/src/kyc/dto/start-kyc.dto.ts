import { z } from 'zod'

import { CountrySchema } from '../schemas/kyc-enums.schema'

export const StartKycSchema = z.object({
  country: CountrySchema,
})
export type StartKycDto = z.infer<typeof StartKycSchema>
