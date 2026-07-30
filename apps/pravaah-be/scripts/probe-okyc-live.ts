/**
 * Run the DigiLocker post-consent flow against a REAL consented session, from
 * the command line, without going through the app.
 *
 * Useful because the provider answers `error_invalid_transaction_id` for a
 * session it has never seen, one that is un-consented, AND one whose code has
 * not been exchanged — so a failure in the app tells you almost nothing. This
 * runs the two calls in order and prints exactly which one broke.
 *
 *   npm run okyc:probe -- --code=<the code DigiLocker showed>
 *   npm run okyc:probe -- --code=<code> --txn=<session id>   # explicit session
 *
 * With no `--txn` it uses the newest PENDING AADHAAR_OKYC reference in the
 * database, which is the session the app most recently opened.
 *
 * Read-only: it writes nothing, and every call carries a unique reference_id so
 * none of them collide with Decentro's duplicate-request guard.
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'

import { PrismaPg } from '@prisma/adapter-pg'
import axios from 'axios'
import { config } from 'dotenv'

import { PrismaClient } from '../generated/prisma/client'

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

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
}

const BASE = process.env.DECENTRO_BASE_URL ?? ''
const HEADERS = {
  'content-type': 'application/json',
  client_id: process.env.DECENTRO_CLIENT_ID ?? '',
  client_secret: process.env.DECENTRO_CLIENT_SECRET ?? '',
  module_secret: process.env.DECENTRO_MODULE_SECRET ?? '',
}
const PURPOSE = 'Customer KYC identity check'

async function call(
  label: string,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await axios.post(
      `${BASE}${path}`,
      { reference_id: `probe_${randomUUID()}`, ...body },
      { headers: HEADERS, timeout: 20_000, validateStatus: () => true },
    )
    const d = res.data as Record<string, unknown>
    const payload = (d.data ?? d.kycResult) as
      | Record<string, unknown>
      | undefined
    const message = (payload?.message ?? d.message) as unknown

    console.log(`\n── ${label}`)
    console.log(`   ${path}  HTTP ${res.status}`)
    console.log(`   responseKey  ${String(d.responseKey ?? '-')}`)
    console.log(`   message      ${String(message ?? '-')}`)
    if (d.responseCode === 'S00000') {
      console.log('   *** SUCCESS ***')
      console.log(JSON.stringify(d, null, 2))
    }
  } catch (e) {
    console.log(`\n── ${label}\n   ${path}  threw: ${String(e)}`)
  }
}

async function main(): Promise<void> {
  const code = arg('code')
  let txn = arg('txn')

  if (!txn) {
    const check = await prisma.kycCheck.findFirst({
      where: { checkType: 'AADHAAR_OKYC', providerRefId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { providerRefId: true, createdAt: true },
    })
    txn = check?.providerRefId ?? undefined
    console.log(
      `session from db: ${txn ?? '(none found)'}  recorded ${
        check?.createdAt.toISOString() ?? '-'
      }`,
    )
  }
  if (!txn) throw new Error('No session id. Pass --txn=<decentroTxnId>.')
  console.log(`session : ${txn}`)
  console.log(`code    : ${code ?? '(none supplied)'}`)

  const consent = { consent: true, consent_purpose: PURPOSE }

  /**
   * The real flow, in order. Step 1 is the one that is easy to miss: without
   * the code exchange the session is unreadable, and every endpoint says
   * `error_invalid_transaction_id` — the same thing it says for a session that
   * never existed. Run this within a minute or two of consent; the
   * authorisation code is single-use and expires quickly.
   */
  if (code) {
    await call(
      '1. exchange the DigiLocker code',
      '/v2/kyc/digilocker/access_token/code',
      {
        initial_decentro_transaction_id: txn,
        digilocker_code: code,
        ...consent,
      },
    )
  } else {
    console.log('\n(no --code supplied, skipping the exchange step)')
  }

  await call('2. fetch the eAadhaar', '/v2/kyc/digilocker/eaadhaar', {
    initial_decentro_transaction_id: txn,
    ...consent,
  })
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
