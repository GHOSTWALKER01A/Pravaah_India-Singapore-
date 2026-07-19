import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common'

const PRISMA_CODE_TO_HTTP: Record<
  string,
  { factory: (message: string) => HttpException }
> = {
  P2002: {
    factory: (msg) =>
      new ConflictException({
        message: msg || 'A record with this value already exists',
        code: 'UNIQUE_VIOLATION',
      }),
  },
  P2003: {
    factory: (msg) =>
      new BadRequestException({
        message: msg || 'Invalid reference',
        code: 'INVALID_REFERENCE',
      }),
  },
  P2014: {
    factory: (msg) =>
      new BadRequestException({
        message: msg || 'Invalid relation',
        code: 'INVALID_RELATION',
      }),
  },
  P2025: {
    factory: (msg) =>
      new NotFoundException({
        message: msg || 'Record not found',
        code: 'NOT_FOUND',
      }),
  },
}

function isPrismaKnownRequestError(
  err: unknown,
): err is { code: string; message?: string; meta?: unknown } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('P')
  )
}

export function handlePrismaError(err: unknown): never {
  if (err instanceof HttpException) {
    throw err
  }
  if (isPrismaKnownRequestError(err)) {
    const mapping = PRISMA_CODE_TO_HTTP[err.code]
    if (mapping) {
      throw mapping.factory(err.message ?? '')
    }
  }
  throw err
}
