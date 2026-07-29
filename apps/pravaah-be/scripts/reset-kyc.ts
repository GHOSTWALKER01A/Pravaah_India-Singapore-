/**
 * Resets a single user's M0 (KYC) state so the verification flow can be walked
 * again from step one.
 *
 *   npm run kyc:reset -- --phone=+919998887776 --dry-run
 *   npm run kyc:reset -- --phone=+919998887776
 *
 * ## Why this script exists
 *
 * There is no dev bypass of KYC anywhere in the codebase — every gate reads
 * `User.kycStatus` and the orchestrator only ever writes it from `reevaluate()`.
 * What LOOKS like a bypass on the dev bypass number (`AUTH_DEV_BYPASS_PHONE`) is
 * a completed KYC record left behind by an earlier test run: the app's
 * `nextCheck()` finds every required check already cleared and jumps straight to
 * the status screen. Re-testing the flow therefore means clearing the DATA, not
 * changing code.
 *
 * ## Scope: M0 only, deliberately
 *
 * Deleted: the `KycCheck` rows, any `ReviewCase` on the profile, and the
 * `IdentityDocument` rows collected during the flow. Reset: `KycProfile` back to
 * NOT_STARTED with its derived fields (name match, verified name, completion,
 * risk) cleared, and `User.kycStatus` to match.
 *
 * NOT touched: the `User` row itself, its `pravaahId` (an issued ID is permanent
 * — reassigning one would break every credential and ledger row that quotes it),
 * device bindings, PIN, and every downstream module's data. Those M1–M7 rows stay
 * where they are; their own VERIFIED gates will simply refuse until this user
 * clears KYC again, which is the honest behaviour.
 *
 * `KycProfile` is reset rather than deleted so `startedAt` and the row's id
 * survive — `getOrCreateProfile` would recreate it anyway, and keeping the id
 * means an audit trail that already references it does not dangle.
 *
 * Safe to re-run: every write is idempotent, and a user with no profile is
 * reported and skipped rather than treated as an error.
 */
import { resolve } from 'path'

import { PrismaPg } from '@prisma/adapter-pg'
import { config } from 'dotenv'

import { KycStatus, PrismaClient } from '../generated/prisma/client'

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

const dryRun = process.argv.includes('--dry-run')

/** `--phone=+919998887776`, digits-only compared so the format is forgiving. */
function argPhone(): string {
  const raw = process.argv
    .find((a) => a.startsWith('--phone='))
    ?.slice('--phone='.length)
  if (!raw) {
    throw new Error(
      'A --phone=<number> is required, e.g. npm run kyc:reset -- --phone=+919998887776',
    )
  }
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) throw new Error(`Not a phone number: ${raw}`)
  return digits
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

async function main(): Promise<void> {
  const digits = argPhone()

  /**
   * Matched on the trailing digits rather than an exact `phone` equality, because
   * a row can be stored as `+919998887776` while the argument arrives as
   * `9998887776` (or vice versa). A `contains` over the digits is the same
   * tolerance `TwilioVerifyService.isBypass` applies.
   */
  const users = await prisma.user.findMany({
    where: { phone: { contains: digits } },
    select: {
      id: true,
      phone: true,
      kycStatus: true,
      pravaahId: true,
      kycProfile: { select: { id: true, overallStatus: true } },
    },
  })

  if (users.length === 0) {
    console.log(`✔ No user matches …${digits.slice(-10)} — nothing to reset.`)
    return
  }
  // Refuse rather than guess: resetting the wrong person's KYC is not undoable.
  if (users.length > 1) {
    throw new Error(
      `${users.length} users match …${digits.slice(-10)}: ${users
        .map((u) => `${u.phone} (${u.id})`)
        .join(', ')}. Pass a fuller number.`,
    )
  }

  const user = users[0]
  console.log(
    `${dryRun ? '[dry run] ' : ''}Resetting KYC for ${user.phone} (${user.id}, ${user.pravaahId})`,
  )
  console.log(
    `   current: user.kycStatus=${user.kycStatus}, profile=${
      user.kycProfile?.overallStatus ?? 'none'
    }`,
  )

  const profileId = user.kycProfile?.id ?? null

  const [checks, reviews, documents] = await Promise.all([
    profileId
      ? prisma.kycCheck.count({ where: { kycProfileId: profileId } })
      : 0,
    profileId
      ? prisma.reviewCase.count({ where: { kycProfileId: profileId } })
      : 0,
    prisma.identityDocument.count({ where: { userId: user.id } }),
  ])
  console.log(
    `   to delete: ${checks} check(s), ${reviews} review case(s), ${documents} document(s)`,
  )

  if (dryRun) {
    console.log('[dry run] No writes were made.')
    return
  }

  /**
   * One transaction, and the ORDER matters: the `ReviewCase` goes before the
   * checks so an interrupted run can never leave an OPEN case pointing at a
   * profile whose evidence is gone — a case the console would render as a review
   * with nothing to review.
   */
  await prisma.$transaction(async (tx) => {
    if (profileId) {
      await tx.reviewCase.deleteMany({ where: { kycProfileId: profileId } })
      await tx.kycCheck.deleteMany({ where: { kycProfileId: profileId } })
      await tx.kycProfile.update({
        where: { id: profileId },
        data: {
          overallStatus: KycStatus.NOT_STARTED,
          nameMatchScore: null,
          riskScore: null,
          verifiedName: null,
          completedAt: null,
        },
      })
    }
    await tx.identityDocument.deleteMany({ where: { userId: user.id } })
    await tx.user.update({
      where: { id: user.id },
      data: { kycStatus: KycStatus.NOT_STARTED },
    })
  })

  console.log(
    `✔ ${user.phone} is back to NOT_STARTED. The next GET /kyc/status returns nextStep=PAN (India) — start the flow from the Verify tab.`,
  )
}

main()
  .catch((error) => {
    console.error('✖ KYC reset failed:', error)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
