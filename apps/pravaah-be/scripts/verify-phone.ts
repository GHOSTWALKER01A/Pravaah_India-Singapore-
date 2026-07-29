/**
 * Phone-number parsing, as a payment address.
 *
 * This is arithmetic-free but it decides WHERE MONEY GOES: a mis-parse turns `+91 98765 43210` into
 * a different payable address, and UPI is irreversible. So the parser gets the same treatment as the
 * money and QR layers — an executable harness rather than a claim in a comment.
 *
 * The cases below are the ones that actually arrive. People paste from contact lists, which means the
 * input genuinely contains spaces, dashes, brackets, leading zeros and country codes, and a parser
 * that only accepts bare digits would reject correct numbers on formatting grounds.
 *
 * Run: npx tsx scripts/verify-phone.ts
 */

import {
  DIALLING_CODE,
  isMobileNumber,
  maskPhone,
  mobileVpaCandidates,
  parsePhone,
  payNowMobileProxy,
} from '../src/modules/payments/phone.util'

let passed = 0
const failures: string[] = []

function eq(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`[  ok  ] ${label}`)
  } else {
    failures.push(
      `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
    console.log(
      `[ FAIL ] ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

// ── India: the formats a contact list actually produces ─────────────────────
console.log('\n── India: every way one number gets typed ──\n')

const IN_E164 = '+919876543210'
for (const [label, input] of [
  ['bare 10 digits', '9876543210'],
  ['with spaces', '98765 43210'],
  ['with a dash', '98765-43210'],
  ['country code and +', '+919876543210'],
  ['country code, spaced', '+91 98765 43210'],
  ['country code, no +', '919876543210'],
  ['00 international prefix', '00919876543210'],
  ['leading trunk zero', '09876543210'],
  ['brackets and dots', '(+91) 98765.43210'],
] as const) {
  eq(`IN ${label} → ${IN_E164}`, parsePhone(input, 'IN')?.e164, IN_E164)
}

console.log('\n── India: what must be refused ──\n')
for (const [label, input] of [
  ['9 digits', '987654321'],
  ['11 digits', '98765432101'],
  ['starts with 5 (not a mobile range)', '5876543210'],
  ['starts with 1 (service range)', '1876543210'],
  ['starts with 0 at 10 digits', '0876543210'],
  ['letters only', 'ravi@pravaah'],
  ['empty-ish', '   '],
] as const) {
  eq(`IN rejects ${label}`, parsePhone(input, 'IN'), null)
}

/**
 * The case that would be silently wrong.
 *
 * A Singapore number is 8 digits; an Indian one is 10. `81234567` is a valid SG mobile and NOT a
 * valid IN one, and the reverse holds for `9876543210`. If the country were inferred from the digits
 * instead of stated, one of these would resolve against the wrong rail — which pays a stranger in
 * another country over an irreversible network.
 */
console.log('\n── the two countries must not accept each other ──\n')
eq('SG number is not a valid IN number', parsePhone('81234567', 'IN'), null)
eq('IN number is not a valid SG number', parsePhone('9876543210', 'SG'), null)

// ── Singapore ───────────────────────────────────────────────────────────────
console.log('\n── Singapore: PayNow proxies ──\n')
const SG_E164 = '+6581234567'
for (const [label, input] of [
  ['bare 8 digits', '81234567'],
  ['with country code', '+6581234567'],
  ['country code, spaced', '+65 8123 4567'],
  ['starts with 9', '91234567'],
] as const) {
  const parsed = parsePhone(input, 'SG')
  eq(`SG ${label} parses`, parsed !== null, true)
}
eq(`SG canonical form is E.164`, parsePhone('8123 4567', 'SG')?.e164, SG_E164)

eq('SG rejects 7 digits', parsePhone('8123456', 'SG'), null)
eq('SG rejects a landline range (6)', parsePhone('61234567', 'SG'), null)

/**
 * PayNow addresses the proxy WITH the `+`.
 *
 * `+6581234567` and `81234567` are different strings to the directory and the second does not
 * resolve, so this is checked rather than assumed.
 */
const sgParsed = parsePhone('81234567', 'SG')!
eq(
  'PayNow proxy keeps the + and country code',
  payNowMobileProxy(sgParsed),
  SG_E164,
)

// ── candidate generation ────────────────────────────────────────────────────
console.log('\n── VPA candidates for an Indian mobile ──\n')

const candidates = mobileVpaCandidates('9876543210', 'pravaah', [
  'ybl',
  'paytm',
])
eq(
  'our own suffix is probed FIRST (free, internal, settles instantly)',
  candidates[0],
  '9876543210@pravaah',
)
eq('then the PSPs in order', candidates.slice(1), [
  '9876543210@ybl',
  '9876543210@paytm',
])

eq(
  'the limit is honoured — each extra candidate is a rate-limited rail call',
  mobileVpaCandidates(
    '9876543210',
    'pravaah',
    ['a', 'b', 'c', 'd', 'e', 'f'],
    3,
  ).length,
  3,
)

eq(
  'a duplicate suffix is not probed twice',
  mobileVpaCandidates('9876543210', 'pravaah', ['pravaah', 'ybl']),
  ['9876543210@pravaah', '9876543210@ybl'],
)

eq(
  'a suffix written with a leading @ is tolerated',
  mobileVpaCandidates('9876543210', 'pravaah', ['@ybl']),
  ['9876543210@pravaah', '9876543210@ybl'],
)

// ── masking ─────────────────────────────────────────────────────────────────
console.log(
  '\n── masking: a payee list is one screenshot from being shared ──\n',
)

const masked = maskPhone(IN_E164, 'IN')
eq('masked keeps only the last two digits', masked.endsWith('10'), true)
eq('masked hides the rest', masked.includes('98765'), false)
eq('masked still says which country', masked.startsWith('+91'), true)
eq(
  'an unparseable number is still masked rather than echoed',
  maskPhone('98765', 'IN').includes('98765'),
  false,
)

// ── the dialling codes are the two corridors ────────────────────────────────
eq(
  'dialling codes cover exactly IN and SG',
  Object.keys(DIALLING_CODE).sort(),
  ['IN', 'SG'],
)
eq(
  'isMobileNumber agrees with parsePhone',
  isMobileNumber('9876543210', 'IN'),
  true,
)
eq(
  'isMobileNumber rejects what parsePhone rejects',
  isMobileNumber('123', 'IN'),
  false,
)

// ── result ──────────────────────────────────────────────────────────────────
const line = '═'.repeat(70)
console.log(`\n${line}`)
if (failures.length === 0) {
  console.log(
    `ALL ${passed} CHECKS PASSED — phone numbers parse to one address per country.`,
  )
  console.log(line)
} else {
  console.log(`${failures.length} FAILED of ${passed + failures.length}:`)
  for (const failure of failures) console.log(`  · ${failure}`)
  console.log(line)
  process.exit(1)
}
