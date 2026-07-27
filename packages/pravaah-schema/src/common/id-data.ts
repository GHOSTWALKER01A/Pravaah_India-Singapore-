import { z } from 'zod'

/** Reusable `{ id }` payload returned by create/delete mutations. */
export const idDataSchema = z.object({ id: z.string().uuid() })

export type IdData = z.infer<typeof idDataSchema>
