/**
 * Postgres transaction safety: never issue a command on a transaction client after a caught error.
 *
 * **The bug this exists for.** `LedgerService.ensureAccount` did this:
 *
 * ```ts
 * try { return await client.ledgerAccount.create({ … }) }
 * catch (error) {
 *   if (isUniqueViolation(error)) {
 *     const found = await client.ledgerAccount.findUnique({ where })   // ← poisoned
 * ```
 *
 * `client` is normally a transaction client, because posting money is one transaction. In Postgres a
 * failed statement aborts the ENTIRE transaction, so once that `create` hit the unique constraint,
 * every later command on the same handle returned `25P02 current transaction is aborted, commands
 * ignored until end of transaction block`.
 *
 * Two things made it expensive to diagnose. The 25P02 REPLACED the unique violation on the way out,
 * so the logs named a Postgres state error while the real cause was a lost race on a wallet row. And
 * every retry reproduced it — `recoverStuckSagas` re-drove the same transfer, raced the same account
 * creation, and poisoned its own transaction, so a single race turned into a permanently stuck saga.
 *
 * Recovering inside a transaction requires a SAVEPOINT, and Prisma's interactive transactions do not
 * wrap individual statements in one. The fix is to never let the statement fail: `createMany` with
 * `skipDuplicates` compiles to `INSERT … ON CONFLICT DO NOTHING`, so a conflict is not an error and
 * nothing is aborted.
 *
 * **Why a script and not a lint rule.** This is invisible to `tsc` — the code is perfectly typed —
 * and this app's ESLint setup has no rule that models transaction state. The pattern is textual, so
 * the check is textual.
 *
 * Run: npx tsx scripts/verify-tx-safety.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')

let passed = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`[  ok  ] ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`[ FAIL ] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Strip comments and template/string literals so the scan never fires on prose about the bug. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => ' '.repeat(m.length))
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      out.push(full)
  }
  return out
}

/**
 * The handles that might be a transaction client.
 *
 * `tx` and `client` by convention, plus any parameter actually typed
 * `Prisma.TransactionClient`. `this.prisma` is deliberately NOT in this set: it is the base client, so
 * a query on it opens a fresh connection and is the CORRECT way to recover from a violation.
 */
const TX_HANDLES = ['tx', 'client', 'trx', 'transactionClient']

console.log('\n── no command on a transaction client inside a catch block ──\n')

const files = walk(SRC)
const offenders: string[] = []

for (const file of files) {
  const source = stripNonCode(readFileSync(file, 'utf8'))
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    if (!/}\s*catch\s*\(/.test(lines[i])) continue

    /**
     * Walk the catch body by brace depth rather than a fixed window.
     *
     * A fixed lookahead would miss a long catch block and would bleed into the code after a short
     * one — reporting a safe query as an offence, which is how a checker gets ignored.
     */
    let depth = 0
    let started = false
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j]
      for (const ch of line) {
        if (ch === '{') {
          depth += 1
          started = true
        } else if (ch === '}') depth -= 1
      }

      if (j > i || started) {
        for (const handle of TX_HANDLES) {
          // `tx.something.query(` — a Prisma model call on a transaction handle.
          const pattern = new RegExp(`\\b${handle}\\.\\w+\\.\\w+\\(`)
          if (pattern.test(line)) {
            offenders.push(
              `${file.replace(/\\/g, '/').split('/src/')[1]}:${j + 1} — \`${handle}.…\` inside a catch (line ${i + 1})`,
            )
          }
        }
      }

      if (started && depth <= 0) break
    }
  }
}

check(
  'scanned the whole backend',
  files.length > 50,
  `only ${files.length} files seen — the walk is not reaching src/`,
)
console.log(`         ${files.length} files scanned`)

check(
  'no transaction-client command occurs inside a catch block',
  offenders.length === 0,
  offenders.join('; '),
)

/**
 * The specific fix stays in place.
 *
 * `ensureAccount` must keep using `ON CONFLICT DO NOTHING`. Reverting it to create-then-catch would
 * reintroduce a permanently stuck saga on the first concurrent transfer, and the generic scan above
 * would catch that — but naming it makes the failure message say what actually broke.
 */
console.log('\n── the ledger account race stays atomic ──\n')

const ledger = readFileSync(
  join(SRC, 'modules', 'payments', 'services', 'ledger.service.ts'),
  'utf8',
)
const ensureBody = ledger.slice(
  ledger.indexOf('async ensureAccount('),
  ledger.indexOf('/** The user’s spendable wallet. */') > 0
    ? ledger.indexOf('/** The user’s spendable wallet. */')
    : ledger.indexOf('userWallet('),
)

check(
  'ensureAccount inserts with skipDuplicates',
  /createMany\(/.test(ensureBody) && /skipDuplicates:\s*true/.test(ensureBody),
  'a conflict must be a no-op, not an exception, or it aborts the caller’s transaction',
)
check(
  'ensureAccount does not create-then-catch',
  !/catch/.test(ensureBody),
  'catching a unique violation here poisons the money-moving transaction (25P02)',
)

const line = '='.repeat(70)
console.log(`\n${line}`)
if (failures.length === 0) {
  console.log(
    `ALL ${passed} CHECKS PASSED — no caught error is followed by a command on the same transaction.`,
  )
  console.log(line)
} else {
  console.log(`${failures.length} FAILED of ${passed + failures.length}:`)
  for (const failure of failures) console.log(`  · ${failure}`)
  console.log(line)
  process.exit(1)
}
