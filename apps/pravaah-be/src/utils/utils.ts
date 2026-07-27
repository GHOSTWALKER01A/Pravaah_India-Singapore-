import { createAppLogger } from '@pravaah/nestjs-logger'
import { z } from 'zod'

const logger = createAppLogger({ serviceName: 'pravaah-be' }).child({
  context: 'Validation',
})

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  })
}

/**
 * Custom error class for validation failures.
 * Provides structured error information including formatted validation issues.
 */
export class ValidationError extends Error {
  public readonly formattedErrors: Array<{
    path: string
    message: string
    code: string
  }>

  constructor(
    message: string,
    public readonly zodError: z.ZodError,
    public readonly context?: string,
  ) {
    super(message)
    this.name = 'ValidationError'
    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ValidationError)
    }

    // Format errors for easier consumption (consistent with ZodValidationPipe)
    this.formattedErrors = zodError.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'root',
      message: issue.message,
      code: issue.code,
    }))
  }

  /**
   * Get the first validation error message (useful for simple error handling)
   */
  get firstError(): string {
    return this.formattedErrors[0]?.message || this.message
  }
}

/**
 * Validates request/input data against a Zod schema.
 * Uses safeParse for better performance and error handling.
 *
 * @param schema - The Zod schema to validate against
 * @param request - The data to validate
 * @param context - Optional context string for error messages (e.g., 'createUser', 'updateEvent')
 * @returns The validated and typed data
 * @throws {ValidationError} If validation fails
 *
 * @example
 * ```typescript
 * const validated = validateRequest(createUserSchema, userData, 'createUser')
 * ```
 */
export function validateRequest<T extends z.ZodTypeAny>(
  schema: T,
  request: unknown,
  context?: string,
): z.infer<T> {
  const result = schema.safeParse(request)

  if (!result.success) {
    const contextMsg = context
      ? `Invalid ${context} request`
      : 'Request validation failed'
    logger.error(`${contextMsg}: ${result.error.message}`, {
      stack: result.error.stack,
    })
    throw new ValidationError(
      `${contextMsg}: ${result.error.message}`,
      result.error,
      context,
    )
  }

  return result.data
}

/**
 * Validates response/output data against a Zod schema.
 * Useful for validating API responses, database results, or external service responses.
 * Uses safeParse for better performance and error handling.
 *
 * @param schema - The Zod schema to validate against
 * @param response - The data to validate
 * @param context - Optional context string for error messages (e.g., 'getUser', 'fetchEvents')
 * @returns The validated and typed data
 * @throws {ValidationError} If validation fails
 *
 * @example
 * ```typescript
 * const validated = validateResponse(userResponseSchema, apiResponse, 'getUser')
 * ```
 */
export function validateResponse<T extends z.ZodTypeAny>(
  schema: T,
  response: unknown,
  context?: string,
): z.infer<T> {
  const result = schema.safeParse(response)

  if (!result.success) {
    const contextMsg = context
      ? `Invalid ${context} response`
      : 'Response validation failed'
    logger.error(`${contextMsg}: ${result.error.message}`, {
      stack: result.error.stack,
    })
    throw new ValidationError(
      `${contextMsg}: ${result.error.message}`,
      result.error,
      context,
    )
  }

  return result.data
}
