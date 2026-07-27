import { z } from 'zod'

export const SingpassCallbackSchema = z.object({
  providerRefId: z.string().min(1),
})
export type SingpassCallbackDto = z.infer<typeof SingpassCallbackSchema>

/** Mock Singpass consent — tester selects an official test persona (dev only). */
export const SelectPersonaSchema = z.object({
  uinfin: z.string().min(1),
})
export type SelectPersonaDto = z.infer<typeof SelectPersonaSchema>
