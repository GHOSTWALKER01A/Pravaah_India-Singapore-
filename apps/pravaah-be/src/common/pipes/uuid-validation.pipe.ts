import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common'
import { z } from 'zod'

const uuidSchema = z.string().uuid()

/**
 * Validates that a route param is a well-formed UUID before it reaches the
 * service/Prisma layer — a malformed id returns a clean 400 instead of leaking
 * a database error as a 500. Apply per-param: `@Param('id', new UUIDValidationPipe())`.
 */
@Injectable()
export class UUIDValidationPipe implements PipeTransform {
  transform(value: string): string {
    const result = uuidSchema.safeParse(value)
    if (!result.success) {
      throw new BadRequestException('Invalid UUID format')
    }
    return value
  }
}
