import { z } from 'zod'

import { APIResponseSchema } from '@pravaah/schema'

export const PaginationResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
): ReturnType<
  typeof APIResponseSchema<
    z.ZodObject<{
      items: z.ZodArray<T>
      total: z.ZodNumber
      page: z.ZodNumber
      limit: z.ZodNumber
    }>
  >
> => {
  const paginationDataSchema = z.object({
    items: z.array(itemSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  })

  return APIResponseSchema(paginationDataSchema)
}

export type PaginationResponse<T> = z.infer<
  ReturnType<typeof PaginationResponseSchema<z.ZodType<T>>>
>
