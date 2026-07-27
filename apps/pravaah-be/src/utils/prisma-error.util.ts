import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common'

const PRISMA_CODE_TO_HTTP: Record<string, (hint: string) => HttpException> = {
  P2002: (hint) =>
    new ConflictException({
      message: `A record with this value already exists${hint}`,
      code: 'UNIQUE_VIOLATION',
    }),
  P2003: (hint) =>
    new BadRequestException({
      message: `Invalid reference${hint}`,
      code: 'INVALID_REFERENCE',
    }),
  P2014: (hint) =>
    new BadRequestException({
      message: `Invalid relation${hint}`,
      code: 'INVALID_RELATION',
    }),
  P2025: () =>
    new NotFoundException({ message: 'Record not found', code: 'NOT_FOUND' }),
}

function isPrismaKnownRequestError(
  err: unknown,
): err is { code: string; message?: string; meta?: { target?: unknown } } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('P')
  )
}

/**
 * Name the offending field(s) from `meta.target` without ever leaking Prisma's
 * raw invocation message (which embeds server file paths and the query). Used
 * as the client-facing message instead of `err.message`.
 */
function fieldHint(meta: { target?: unknown } | undefined): string {
  const target = meta?.target
  const fields = Array.isArray(target)
    ? target.filter((t): t is string => typeof t === 'string')
    : typeof target === 'string'
      ? [target]
      : []
  return fields.length ? ` (${fields.join(', ')})` : ''
}

export function handlePrismaError(err: unknown): never {
  if (err instanceof HttpException) {
    throw err
  }
  if (isPrismaKnownRequestError(err)) {
    const mapping = PRISMA_CODE_TO_HTTP[err.code]
    if (mapping) {
      // Never forward `err.message` — it exposes internals. Derive a safe,
      // field-scoped message from `meta.target` instead.
      throw mapping(fieldHint(err.meta))
    }
  }
  throw err
}
