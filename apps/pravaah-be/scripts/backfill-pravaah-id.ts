/**
 * Backfills `User.pravaahId` for rows that predate the column.
 *
 *   npm run pravaah-id:backfill          (from apps/pravaah-be)
 *   npm run pravaah-id:backfill -- --dry-run
 *
 * The column is nullable ONLY so it could be added to a populated table without
 * a blocking write. PravaahIdService repairs any row it touches, so an active
 * user is fixed at their next login — but a dormant user would stay unlabelled
 * and show as `—` in the console. This closes that gap in one pass.
 *
 * Safe to re-run: it only ever selects rows where `pravaahId IS NULL`, and each
 * write is guarded on that same condition, so a row already fixed by a
 * concurrent login is skipped rather than overwritten. An ID, once issued, is
 * permanent — nothing here rewrites one.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'path'

import { PrismaPg } from '@prisma/adapter-pg'
import { config } from 'dotenv'

import { buildPravaahId, PRAVAAH_ID_ENTROPY_SYMBOLS } from '@pravaah/schema'

import { Prisma, PrismaClient } from '../generated/prisma/client'

// Same env-file order as prisma.config.ts, since this runs outside NestJS.
const nodeEnv = process.env.NODE_ENV || 'development'
for (const file of [
  '.env',
  '.env.local',
  `.env.${nodeEnv}`,
  `.env.${nodeEnv}.local`,
]) {
  config({ path: resolve(process.cwd(), file), override: true })
}

const BATCH_SIZE = 500
const MAX_ATTEMPTS = 5
const dryRun = process.argv.includes('--dry-run')

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

function isDuplicate(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  )
}

async function main(): Promise<void> {
  const pending = await prisma.user.count({ where: { pravaahId: null } })
  if (pending === 0) {
    console.log('✔ Every user already has a Pravaah ID — nothing to do.')
    return
  }
  console.log(
    `${dryRun ? '[dry run] ' : ''}${pending} user(s) without a Pravaah ID.`,
  )

  let issued = 0
  let skipped = 0

  // Re-query each round instead of paginating with an offset: the result set
  // shrinks as rows are filled, so a moving offset would step over rows.
  for (;;) {
    const batch = await prisma.user.findMany({
      where: { pravaahId: null },
      select: { id: true },
      take: BATCH_SIZE,
    })
    if (batch.length === 0) break

    for (const user of batch) {
      let done = false
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt += 1) {
        const candidate = buildPravaahId(
          randomBytes(PRAVAAH_ID_ENTROPY_SYMBOLS),
        )
        if (dryRun) {
          console.log(`  would issue ${candidate} → ${user.id}`)
          issued += 1
          done = true
          break
        }
        try {
          const claimed = await prisma.user.updateMany({
            where: { id: user.id, pravaahId: null },
            data: { pravaahId: candidate },
          })
          if (claimed.count > 0) issued += 1
          else skipped += 1 // a concurrent login got there first
          done = true
        } catch (error) {
          if (!isDuplicate(error)) throw error
          console.warn(`  collision on ${candidate}, retry ${attempt}`)
        }
      }
      if (!done) {
        throw new Error(
          `Could not issue a Pravaah ID for ${user.id} after ${MAX_ATTEMPTS} attempts`,
        )
      }
    }

    // A dry run never writes, so the pending set never shrinks — one pass only.
    if (dryRun) break
  }

  console.log(
    dryRun
      ? `[dry run] would issue ${issued} ID(s). No writes were made.`
      : `✔ Issued ${issued} ID(s).${skipped ? ` ${skipped} already filled concurrently.` : ''}`,
  )
}

main()
  .catch((error) => {
    console.error('✖ Backfill failed:', error)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
