/**
 * Every minor-unit column leaves this service as a decimal STRING.
 *
 * This harness exists because of a specific bug that was already in the tree: `JSON.stringify`
 * does not round a `BigInt` and does not stringify it — it THROWS
 * (`TypeError: Do not know how to serialize a BigInt`). So a controller that returns a raw Prisma
 * row containing `amountMinor` does not return a slightly wrong number. It returns a 500, on the
 * exact endpoint an operator opens during an incident, and typecheck says nothing because the
 * shape is perfectly valid TypeScript.
 *
 * Two things are checked, and the second is the one that will catch the NEXT instance:
 *
 *  1. **Runtime.** Each projection is fed a fixture whose every minor field is a BigInt, and the
 *     result must survive `JSON.stringify` with no `bigint` left anywhere in it.
 *  2. **Schema drift.** `schema.prisma` is parsed for every `BigInt` column on the models these
 *     projections cover, and each column name must appear in its projection. Add a BigInt field to
 *     `Reversal` next year and forget the projection, and this fails by name rather than waiting
 *     for a 500 in production.
 *
 * Run: npx tsx scripts/verify-money-serialization.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  presentDispute,
  presentLedgerEntry,
  presentRecon,
  presentReversal,
} from '../src/modules/payments/admin-projection'

const ROOT = join(__dirname, '..')

let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`[  ok  ] ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`[ FAIL ] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Every path through a value that still holds a bigint. */
function bigintPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'bigint') return [path]
  if (value === null || typeof value !== 'object') return []
  if (value instanceof Date) return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      bigintPaths(item, `${path}[${index}]`),
    )
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    bigintPaths(entry, `${path}.${key}`),
  )
}

// ── 1 · runtime ─────────────────────────────────────────────────────────────
const now = new Date('2026-01-01T00:00:00.000Z')

/**
 * A transaction stub, with the BigInt columns the projections read.
 *
 * `9007199254740993n` is deliberate: it is 2^53 + 1, the smallest integer a double cannot
 * represent. If a projection ever reaches for `Number(...)` instead of `.toString()`, this value
 * comes back as ...992 and the assertion below catches it.
 */
const txnStub = {
  id: 'txn-1',
  status: 'SUCCESS',
  corridor: 'DOMESTIC',
  totalDebitMinor: 9_007_199_254_740_993n,
  sourceCurrency: 'INR',
  refundedMinor: 0n,
} as never

const cases: { label: string; output: unknown }[] = [
  {
    label: 'presentReversal',
    output: presentReversal({
      id: 'rev-1',
      transactionId: 'txn-1',
      sequence: 1,
      kind: 'REFUND',
      reason: 'customer asked',
      amountMinor: 9_007_199_254_740_993n,
      status: 'DONE',
      railRef: 'rail-1',
      failureReason: null,
      initiatedByAdminId: null,
      createdAt: now,
      completedAt: now,
    } as never),
  },
  {
    label: 'presentRecon (no transaction)',
    output: presentRecon({
      id: 'rec-1',
      transactionId: 'txn-1',
      source: 'POLL',
      railStatus: 'SUCCESS',
      railCode: '00',
      railAmountMinor: 12_345n,
      internalStatus: 'PENDING',
      status: 'MISMATCH',
      discrepancy: 'rail settled, we had given up',
      action: 'CORRECTED',
      resolvedAt: null,
      resolvedByAdminId: null,
      createdAt: now,
    } as never),
  },
  {
    label: 'presentRecon (with transaction)',
    output: presentRecon({
      id: 'rec-2',
      transactionId: 'txn-1',
      source: 'WEBHOOK',
      railStatus: 'SUCCESS',
      railCode: null,
      railAmountMinor: null,
      internalStatus: 'SUCCESS',
      status: 'MATCHED',
      discrepancy: null,
      action: null,
      resolvedAt: now,
      resolvedByAdminId: null,
      createdAt: now,
      transaction: txnStub,
    } as never),
  },
  {
    label: 'presentDispute (no transaction)',
    output: presentDispute({
      id: 'dis-1',
      userId: 'user-1',
      transactionId: 'txn-1',
      kind: 'NOT_CREDITED',
      status: 'OPEN',
      description: 'payee says nothing arrived',
      claimedAmountMinor: 50_000n,
      evidence: { note: 'screenshot' },
      railRef: null,
      resolution: null,
      resolvedByAdminId: null,
      slaDueAt: now,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    } as never),
  },
  {
    label: 'presentDispute (with transaction)',
    output: presentDispute({
      id: 'dis-2',
      userId: 'user-1',
      transactionId: 'txn-1',
      kind: 'UNAUTHORISED',
      status: 'UNDER_REVIEW',
      description: 'never made this payment',
      claimedAmountMinor: null,
      evidence: null,
      railRef: null,
      resolution: null,
      resolvedByAdminId: 'admin-1',
      slaDueAt: now,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      transaction: txnStub,
    } as never),
  },
  {
    label: 'presentLedgerEntry',
    output: presentLedgerEntry({
      id: 'led-1',
      transactionId: 'txn-1',
      accountId: 'acc-1',
      direction: 'DEBIT',
      amountMinor: 9_007_199_254_740_993n,
      currency: 'INR',
      leg: 'RESERVE',
      legRef: '',
      metadata: null,
      postedAt: now,
      account: {
        id: 'acc-1',
        ownerType: 'USER',
        ownerId: 'user-1',
        type: 'USER_WALLET',
        currency: 'INR',
        label: null,
        allowNegative: false,
        createdAt: now,
      },
    } as never),
  },
]

console.log('\n── runtime: no BigInt survives a projection ──\n')

for (const { label, output } of cases) {
  const stragglers = bigintPaths(output)
  check(
    `${label} leaves no bigint`,
    stragglers.length === 0,
    stragglers.join(', '),
  )

  let serialised = ''
  try {
    serialised = JSON.stringify(output)
    check(`${label} survives JSON.stringify`, true)
  } catch (error) {
    check(
      `${label} survives JSON.stringify`,
      false,
      error instanceof Error ? error.message : 'threw',
    )
  }

  // The 2^53 + 1 tell-tale. `Number()` anywhere in the chain turns this into ...992.
  if (serialised.includes('9007199254740')) {
    check(
      `${label} keeps 2^53+1 exactly`,
      serialised.includes('9007199254740993'),
      'a float rounded it',
    )
  }
}

// ── 2 · schema drift ────────────────────────────────────────────────────────
console.log('\n── schema drift: every BigInt column is projected ──\n')

const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8')
const projectionSource = readFileSync(
  join(ROOT, 'src', 'modules', 'payments', 'admin-projection.ts'),
  'utf8',
)

/** model name → the projection expected to cover it */
const COVERAGE: Record<string, string> = {
  Reversal: 'presentReversal',
  ReconciliationRecord: 'presentRecon',
  PaymentDispute: 'presentDispute',
  LedgerEntry: 'presentLedgerEntry',
}

/** The BigInt column names on one model. */
function bigintColumns(model: string): string[] {
  const match = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(
    schema,
  )
  if (!match) return []
  return [...match[1].matchAll(/^\s*(\w+)\s+BigInt\b/gm)].map((row) => row[1])
}

for (const [model, fn] of Object.entries(COVERAGE)) {
  const columns = bigintColumns(model)
  check(
    `${model} has BigInt columns to project`,
    columns.length > 0,
    'model not found in schema.prisma, or its money columns changed type',
  )

  // The body of the projection, so a field named in a sibling function does not count.
  const body = new RegExp(
    `export function ${fn}\\(([\\s\\S]*?)\\n\\}`,
    'm',
  ).exec(projectionSource)?.[1]
  check(`${fn} is exported`, Boolean(body))

  for (const column of columns) {
    check(
      `${fn} projects ${model}.${column}`,
      Boolean(body?.includes(column)),
      'add it to the projection, or it will 500 the endpoint',
    )
  }
}

// ── result ──────────────────────────────────────────────────────────────────
const line = '═'.repeat(66)
console.log(`\n${line}`)
if (failures.length === 0) {
  console.log(
    `ALL ${passed} CHECKS PASSED — no minor-unit column can reach the wire as a BigInt.`,
  )
  console.log(line)
} else {
  console.log(`${failures.length} FAILED of ${passed + failures.length}:`)
  for (const failure of failures) console.log(`  · ${failure}`)
  console.log(line)
  process.exit(1)
}
