import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common'

import { randomBytes } from 'node:crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { PRAVAAH_ID_ENTROPY_SYMBOLS, buildPravaahId } from '@pravaah/schema'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { Prisma } from 'generated/prisma/client'

/**
 * Issues Pravaah IDs — the permanent public identity every user is shown by
 * (`PVH-XXXX-XXXX-XXXX`). The format itself lives in `@pravaah/schema` so the
 * app and console share one definition; this service owns the two things only
 * the API can do: draw cryptographic entropy, and guarantee uniqueness.
 *
 * Uniqueness is enforced by the unique index on `User.pravaahId`, NOT by a
 * pre-insert existence check. A read-then-write would race two concurrent
 * signups into the same ID; letting the database reject the duplicate (P2002)
 * and retrying is correct under any amount of concurrency.
 */
@Injectable()
export class PravaahIdService {
  /**
   * With 55 bits of entropy a collision needs ~1e8 users before it is even
   * worth a retry, so exhausting five attempts means something is structurally
   * wrong (a broken RNG, an ID space far smaller than intended) — that deserves
   * a loud failure, not a sixth attempt.
   */
  private static readonly MAX_ATTEMPTS = 5

  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PravaahIdService.name })
  }

  /**
   * A fresh candidate ID. Not yet reserved — only a successful write against the
   * unique index makes an ID a user's, so prefer {@link ensureFor} unless you
   * are handling the write (and its P2002) yourself.
   */
  generate(): string {
    return buildPravaahId(randomBytes(PRAVAAH_ID_ENTROPY_SYMBOLS))
  }

  /**
   * The user's Pravaah ID, minting one if the row predates the column.
   *
   * Idempotent and safe to call on every login: for a user who already has an
   * ID the caller has typically already read it, so passing `known` makes this
   * a no-op with zero queries. The lazy mint is what lets the column be added
   * to a live table without a blocking backfill — every legacy row is repaired
   * the first time it is touched.
   */
  async ensureFor(userId: string, known?: string | null): Promise<string> {
    if (known) return known

    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pravaahId: true },
    })
    if (existing?.pravaahId) return existing.pravaahId

    for (
      let attempt = 1;
      attempt <= PravaahIdService.MAX_ATTEMPTS;
      attempt += 1
    ) {
      const candidate = this.generate()
      try {
        // Guarded on `pravaahId: null` so two concurrent callers cannot both
        // assign — the loser updates 0 rows and re-reads the winner's ID below.
        const claimed = await this.prisma.user.updateMany({
          where: { id: userId, pravaahId: null },
          data: { pravaahId: candidate },
        })
        if (claimed.count > 0) {
          this.logger.info(`[${this.ensureFor.name}] Pravaah ID issued`, {
            userId,
            pravaahId: candidate,
          })
          return candidate
        }
        // Someone else won the race (or the row vanished) — trust their value.
        const winner = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { pravaahId: true },
        })
        if (winner?.pravaahId) return winner.pravaahId
        break
      } catch (error) {
        if (!PravaahIdService.isDuplicate(error)) throw error
        // The candidate belongs to a different user. Draw again.
        this.logger.warn(
          `[${this.ensureFor.name}] Pravaah ID collision, retrying`,
          {
            userId,
            attempt,
          },
        )
      }
    }

    throw new InternalServerErrorException('Could not issue a Pravaah ID')
  }

  /** True for a Prisma unique-constraint violation (P2002). */
  private static isDuplicate(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
  }
}
