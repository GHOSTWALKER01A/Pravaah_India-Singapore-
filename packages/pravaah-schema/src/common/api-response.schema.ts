import { z } from 'zod'

/**
 * Envelope every successful API payload is wrapped in. Mirrors the backend's
 * `ResponseBuilder.success` shape so clients can share one contract.
 */
export const APIResponseSchema = <T extends z.ZodTypeAny>(
  schema: T,
): z.ZodObject<{
  data: T
  message: z.ZodOptional<z.ZodString>
}> =>
  z.object({
    data: schema,
    message: z.string().optional(),
  })

export type APIResponse<T> = z.infer<
  ReturnType<typeof APIResponseSchema<z.ZodType<T>>>
>
