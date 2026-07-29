/**
 * Remove duplicate UPI handles so the missing `vpa` unique index can be built.
 *
 * **What went wrong.** In the dev database, `UpiHandle` carries only its primary-key index — the
 * `@unique` on `vpa` was never created. Every other M4 table has its unique constraints, including
 * `LedgerEntry`'s five-column concurrency defence, so this is one index that failed to build rather
 * than a migration that did not run. The likely cause is the ordinary one: `prisma db push` cannot
 * create a unique index over a column that already holds duplicates, so it skipped it and carried on.
 *
 * The duplicates came from two bugs that compounded. Handles were created `PENDING`, and
 * `allocate()`'s idempotency guard looked for an `ACTIVE` one — so the guard never matched and every
 * visit to the Pay tab inserted another row. With no unique index to stop it, each insert succeeded
 * against the same first candidate address.
 *
 * **Why this matters more than the missing QR.** `UpiHandleService`'s whole allocation strategy is
 * "walk candidates and let the database decide", because any `findUnique` check is stale the moment
 * it returns. Without the index, `isUniqueViolation` never fires, so the first candidate always wins
 * — which means EVERY verified user would be allocated the same address, and payments to it would
 * resolve to whichever row was found first. Two people holding one payable address is the exact
 * failure the class comment says is "impossible rather than merely intended".
 *
 * **What this keeps.** For each duplicated `vpa`, the surviving row is the one most likely to be the
 * real one: primary first, then oldest. Rows are DELETED rather than deactivated, which is the one
 * place in this codebase where that is correct — a deactivated row keeps its `vpa` forever precisely
 * so the address is never reused, and keeping these would preserve the duplication the index needs
 * gone. They are also unreferenced: `paymentQr` is empty and no ledger entry points at a handle.
 *
 * Run:  npx tsx scripts/repair-upi-handles.ts
 * Then: npm run prisma:push   (which can now build UpiHandle_vpa_key)
 */

import { resolve } from 'path'

import { PrismaPg } from '@prisma/adapter-pg'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.development.local') })

import { PrismaClient } from '../generated/prisma/client'

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

async function main(): Promise<void> {
  console.log('🔧 Repairing UpiHandle duplicates\n')

  const handles = await prisma.upiHandle.findMany({
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      vpa: true,
      userId: true,
      isPrimary: true,
      status: true,
      createdAt: true,
    },
  })

  if (handles.length === 0) {
    console.log('   nothing to repair — no handles exist')
    return
  }

  // First seen wins, and the ordering above is what makes that the right one: primary, then oldest.
  const keep = new Map<string, string>()
  const drop: typeof handles = []

  for (const handle of handles) {
    if (keep.has(handle.vpa)) {
      drop.push(handle)
    } else {
      keep.set(handle.vpa, handle.id)
    }
  }

  console.log(
    `   ${handles.length} handle(s), ${keep.size} distinct address(es)`,
  )

  if (drop.length === 0) {
    console.log('   ✔ no duplicates — the unique index can be created as-is')
  } else {
    for (const handle of drop) {
      console.log(
        `   – dropping ${handle.vpa} (${handle.status}, primary=${handle.isPrimary}, ${handle.createdAt.toISOString()})`,
      )
    }
    const { count } = await prisma.upiHandle.deleteMany({
      where: { id: { in: drop.map((h) => h.id) } },
    })
    console.log(`   ✔ removed ${count} duplicate row(s)`)
  }

  /**
   * Promote the survivor and activate it.
   *
   * A holder whose only remaining handle is PENDING still cannot receive and still cannot carry a QR,
   * so repairing the duplication without this would leave the original symptom in place. `allocate`
   * now creates handles ACTIVE for the same reason: the money lands in a ledger account we control,
   * not in a bank account that has to be proven first.
   */
  for (const [vpa, id] of keep) {
    const updated = await prisma.upiHandle.update({
      where: { id },
      data: { isPrimary: true, status: 'ACTIVE', verifiedAt: new Date() },
      select: { vpa: true, status: true },
    })
    console.log(`   ✔ ${updated.vpa} → ${updated.status}, primary`)
    void vpa
  }

  console.log('\n   Next: npm run prisma:push   (builds UpiHandle_vpa_key)')
  console.log(
    '   Then: npm run prisma:seed   (ledger, receive codes, balances)',
  )
}

void main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (error: unknown) => {
    console.error(error)
    await prisma.$disconnect()
    process.exit(1)
  })
