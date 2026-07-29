/**
 * Zod schema composition, and the crash it caused.
 *
 * `POST /payments/transfers/:id/dispute` used to build its body schema with
 * `RaiseDisputeSchema.omit({ transactionId: true })`. Under Zod 4 that throws:
 *
 *     Error: .omit() cannot be used on object schemas containing refinements
 *
 * It throws at MODULE LOAD, inside a decorator argument, so it is not a failed request — it is the
 * whole application refusing to start. And `tsc` is completely silent about it, because `.omit()`
 * type-checks perfectly against a refined object; the prohibition is enforced only at runtime.
 *
 * That combination — invisible to typecheck, fatal at boot — is why this file exists. It checks two
 * things:
 *
 *  1. **Statically:** no `.omit()` / `.pick()` / `.partial()` / `.required()` in the backend or the
 *     schema package is applied to a schema that carries a refinement. This catches the next
 *     instance before anyone runs the app.
 *  2. **At runtime:** the dispute rule that was at risk still fires on BOTH schemas. The tempting
 *     fix for the crash is to omit from an unrefined base and move on, which boots cleanly and
 *     silently accepts an `AMOUNT_MISMATCH` dispute with no amount. That would be a worse outcome
 *     than the crash, so it is asserted against directly.
 *
 * Run: npx tsx scripts/verify-dto-composition.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { RaiseDisputeBodySchema, RaiseDisputeSchema } from '@pravaah/schema'

const BE_SRC = join(__dirname, '..', 'src')
const PKG_SRC = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'pravaah-schema',
  'src',
)

let passed = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`[  ok  ] ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`[ FAIL ] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Strip comments and string literals before scanning.
 *
 * Without this the detector fires on its own subject matter: the comments that explain this bug
 * necessarily contain the text `RaiseDisputeSchema.omit(...)`, and a checker that reports prose as a
 * violation is one people learn to ignore. Replacing with spaces rather than deleting keeps offsets
 * intact, which is not needed today but stops a future line-number report from being wrong.
 */
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

// ── 1 · static: nothing structurally composes a refined schema ──────────────
console.log('\n── static: no .omit()/.pick() on a refined schema ──\n')

const files = [...walk(BE_SRC), ...walk(PKG_SRC)]

/**
 * Schemas that carry a refinement.
 *
 * Matched by finding an `export const XSchema = …` whose declaration body reaches a `.refine(`,
 * `.superRefine(` or `.check(` before the next top-level `export`. Deliberately textual: importing
 * every schema to introspect it would not help, because Zod exposes no public "has refinements"
 * flag — the check lives inside `util.ts` and throws rather than reporting.
 */
const refined = new Set<string>()
for (const file of files) {
  // Stripped here too, not only in the scan below: a doc comment that mentions a schema name near
  // the word `.refine(` would otherwise classify an unrefined schema as refined, and every later
  // false positive would trace back to prose rather than to code.
  const source = stripNonCode(readFileSync(file, 'utf8'))
  for (const block of source.split(/\nexport (?=const|type)/)) {
    const name = /^const (\w*Schema)\s*=/.exec(block)?.[1]
    if (!name) continue
    const decl = block.split(/\nexport /)[0] ?? ''
    if (/\.(refine|superRefine|check)\(/.test(decl)) refined.add(name)
  }
}

check(
  'found the refined schemas to guard',
  refined.size > 0,
  'the detector matched nothing, so this harness is not testing anything',
)
console.log(
  `         guarding ${refined.size}: ${[...refined].sort().join(', ')}`,
)

const STRUCTURAL = ['omit', 'pick', 'partial', 'required'] as const
const offenders: string[] = []

for (const file of files) {
  const source = stripNonCode(readFileSync(file, 'utf8'))
  for (const op of STRUCTURAL) {
    // `SomeSchema.omit(` — including across a line break, which is how prettier formats it.
    const pattern = new RegExp(`(\\w*Schema)\\s*\\.\\s*${op}\\(`, 'g')
    for (const match of source.matchAll(pattern)) {
      if (refined.has(match[1])) {
        offenders.push(
          `${file.replace(/\\/g, '/').split('/src/')[1]}: ${match[1]}.${op}()`,
        )
      }
    }
  }
}

check(
  'no structural op is applied to a refined schema',
  offenders.length === 0,
  offenders.join('; '),
)

// ── 2 · runtime: the rule survived being moved ──────────────────────────────
console.log('\n── runtime: the dispute amount rule fires on BOTH schemas ──\n')

const uuid = '11111111-1111-4111-8111-111111111111'
const base = {
  kind: 'AMOUNT_MISMATCH',
  description: 'A different amount arrived than the one I approved.',
}

check(
  'the body schema exists (module loaded without throwing)',
  typeof RaiseDisputeBodySchema?.safeParse === 'function',
)

check(
  'body accepts a payload with no transactionId',
  RaiseDisputeBodySchema.safeParse({ ...base, claimedAmountMinor: '500' })
    .success,
)

/** The regression guard. If this passes, the refinement was NOT lost in the fix. */
const missing = RaiseDisputeBodySchema.safeParse(base)
check('body REJECTS an amount claim with no amount', !missing.success)
if (!missing.success) {
  check(
    'body reports it against claimedAmountMinor, in words',
    missing.error.issues.some(
      (issue) =>
        issue.path[0] === 'claimedAmountMinor' &&
        /State the amount/.test(issue.message),
    ),
  )
}

check(
  'body still accepts a kind that needs no amount',
  RaiseDisputeBodySchema.safeParse({ ...base, kind: 'NOT_CREDITED' }).success,
)

check(
  'the full schema still requires transactionId',
  !RaiseDisputeSchema.safeParse({ ...base, claimedAmountMinor: '500' }).success,
)

check(
  'the full schema still enforces the amount rule',
  !RaiseDisputeSchema.safeParse({ ...base, transactionId: uuid }).success,
)

check(
  'the full schema accepts a complete dispute',
  RaiseDisputeSchema.safeParse({
    ...base,
    transactionId: uuid,
    claimedAmountMinor: '500',
  }).success,
)

// ── result ──────────────────────────────────────────────────────────────────
const line = '═'.repeat(70)
console.log(`\n${line}`)
if (failures.length === 0) {
  console.log(
    `ALL ${passed} CHECKS PASSED — no refined schema is structurally composed, and the dispute rule holds.`,
  )
  console.log(line)
} else {
  console.log(`${failures.length} FAILED of ${passed + failures.length}:`)
  for (const failure of failures) console.log(`  · ${failure}`)
  console.log(line)
  process.exit(1)
}
