/**
 * Read-only snapshot of why a holder cannot see a UPI ID / QR, or pay.
 *
 * Prints the exact inputs the three gates read: `User.kycStatus` (address
 * allocation), the UPI handle rows (QR minting), and the ledger accounts
 * (transfers). Mutates nothing.
 */
import { resolve } from 'path'

import { PrismaPg } from '@prisma/adapter-pg'
import { config } from 'dotenv'

import { PrismaClient } from '../generated/prisma/client'

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

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      pravaahId: true,
      phone: true,
      kycStatus: true,
      primaryCountry: true,
      kycProfile: {
        select: {
          overallStatus: true,
          verifiedName: true,
          nameMatchScore: true,
          checks: {
            select: { checkType: true, status: true, attempt: true },
            orderBy: { attempt: 'asc' },
          },
        },
      },
      upiHandles: { select: { vpa: true, status: true, isPrimary: true } },
    },
  })

  for (const u of users) {
    console.log(`\n=== ${u.pravaahId ?? '(no pravaah id)'}  ${u.phone}`)
    console.log(`    id         ${u.id}`)
    console.log(`    kycStatus  ${u.kycStatus}   country ${u.primaryCountry}`)
    console.log(
      `    profile    ${u.kycProfile?.overallStatus ?? '(none)'}   name ${
        u.kycProfile?.verifiedName ?? '-'
      }   nameMatch ${u.kycProfile?.nameMatchScore ?? '-'}`,
    )

    // Latest attempt per check type wins, same rule the orchestrator uses.
    const latest = new Map<string, string>()
    for (const c of u.kycProfile?.checks ?? []) {
      latest.set(c.checkType, `${c.status}#${c.attempt}`)
    }
    console.log(
      `    checks     ${
        latest.size
          ? [...latest].map(([k, v]) => `${k}=${v}`).join('  ')
          : '(none)'
      }`,
    )
    console.log(
      `    upi        ${
        u.upiHandles.length
          ? u.upiHandles
              .map(
                (h) =>
                  `${h.vpa}[${h.status}${h.isPrimary ? ',primary' : ''}]`,
              )
              .join('  ')
          : '(none)'
      }`,
    )

    const accounts = await prisma.ledgerAccount.findMany({
      where: { ownerId: u.id },
      select: { type: true, currency: true },
    })
    console.log(
      `    ledger     ${
        accounts.length
          ? accounts.map((a) => `${a.type}/${a.currency}`).join('  ')
          : '(none)'
      }`,
    )
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
