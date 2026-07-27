import { z } from 'zod';

/** Standard envelope returned by pravaah-be's ResponseBuilder. */
export const APIResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema,
    message: z.string().optional(),
    success: z.boolean(),
    timestamp: z.string().optional(),
  });

export const PaginationParamsSchema = z.object({
  page: z.number().min(1).optional(),
  limit: z.number().min(1).max(100).optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(
  dataSchema: T,
) =>
  z.object({
    data: z.array(dataSchema),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
      hasNext: z.boolean(),
      hasPrev: z.boolean(),
    }),
  });

export type APIResponse<T> = z.infer<
  ReturnType<typeof APIResponseSchema<z.ZodType<T>>>
>;
export type PaginationParams = z.infer<typeof PaginationParamsSchema>;
export type PaginatedResponse<T> = z.infer<
  ReturnType<typeof PaginatedResponseSchema<z.ZodType<T>>>
>;
