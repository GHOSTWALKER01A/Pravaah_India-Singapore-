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
    typeof err.code === 'string' &&
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

/**
 * Whether an error is a unique-constraint violation (`P2002`).
 *
 * Used by the create-then-catch pattern several modules rely on, where a unique
 * violation is the EXPECTED outcome of two concurrent first-writes rather than a
 * failure — M4's limit counters and M6's velocity buckets both work this way.
 *
 * ## The trap, stated because it has already cost this codebase a debugging session
 *
 * Create-then-catch is only safe OUTSIDE a transaction. In Postgres a failed
 * statement aborts the whole transaction, so a `create` that violates a constraint
 * inside an interactive transaction poisons it: every later command on that client
 * returns `25P02 current transaction is aborted`, and that error REPLACES the
 * unique violation on the way out — so the logs name a Postgres state error while
 * the real cause was a lost race. Inside a transaction, use `createMany` with
 * `skipDuplicates` (which compiles to `ON CONFLICT DO NOTHING`) instead. See the
 * long comment in `LedgerService.ensureAccount`.
 *
 * Duplicated rather than imported from `LedgerService`, deliberately: this is a
 * generic Prisma predicate, and having the cross-cutting fraud module import a
 * money-moving service to borrow a four-line type guard would point the dependency
 * graph the wrong way.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    isPrismaKnownRequestError(err) && (err as { code: string }).code === 'P2002'
  )
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
