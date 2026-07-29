/**
 * M5 micro-insurance self-check — no database, no network, no insurer.
 *
 *   npx tsx scripts/verify-insurance.ts
 *
 * Verifies the five claims M5 rests on, so a regression in the underwriting or
 * ledger maths is caught here rather than in front of a policyholder:
 *
 *   1. REPUTATION PRICING IS REAL — an EXCELLENT-band applicant pays materially
 *      less than a FAIR-band one for identical cover, and the gap is the one the
 *      quote screen claims it is. This is the whole product; if the numbers do not
 *      separate, the pitch is a slide.
 *   2. THE ADVERSE-SELECTION CONTROLS BITE — a thin file is priced conservatively
 *      with a longer wait and a lower ceiling, and a POOR band is declined rather
 *      than sold cover at a price it could never afford.
 *   3. MONEY IS CONSERVED — collect → earn → pay a claim → refund a premium nets
 *      to exactly zero on every account. The trial balance follows from this.
 *   4. THE WAITING PERIOD CANNOT BE WALKED AROUND — the guard compares the
 *      INCIDENT date, so filing late does not convert an uncovered incident into a
 *      covered one.
 *   5. THE TAMPER GATE IS A HARD GATE — a forged document blocks auto-approval on
 *      its own, no matter how small or how otherwise-clean the claim.
 */
import {
  AUTO_APPROVE_CEILING_MINOR,
  BAND_TIER_POLICY,
  CLAIM_AUTO_APPROVE_RISK_CEILING,
  MIN_MULTIPLIER_BPS,
  TAMPER_BLOCK_THRESHOLD,
  THIN_FILE_POLICY,
} from '../src/modules/insurance/insurance.config'
import {
  behaviourNudgeBps,
  computePremium,
  confidencePenaltyBps,
  effectiveMultiplierBps,
  lossRatioBps,
  savingsBps,
  tierCoverCeilingMinor,
} from '../src/modules/insurance/insurance-pricing.util'
import {
  claimPayoutPlan,
  claimReservePlan,
  premiumEarnPlan,
  premiumRefundPlan,
  premiumReservePlan,
  type InsuranceAccounts,
} from '../src/modules/insurance/insurance-posting-plan'
import {
  addDays,
  coverageRefusalFor,
} from '../src/modules/insurance/insurance.state'

import type { Posting } from '../src/modules/payments/services/ledger.service'

// ── harness ─────────────────────────────────────────────────────────────────
let failures = 0

function check(label: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`   ✔ ${label}${detail ? ` — ${detail}` : ''}`)
    return
  }
  failures++
  console.error(`   ✘ ${label}${detail ? ` — ${detail}` : ''}`)
}

function rupees(minor: bigint): string {
  const whole = minor / 100n
  const paise = (minor % 100n).toString().padStart(2, '0')
  return `₹${whole.toString()}.${paise}`
}

// ── fixtures ────────────────────────────────────────────────────────────────
/** The seeded income-protection product. */
const INCOME_PROTECTION = {
  baseRateBps: 900,
  termDays: 365,
  waitingPeriodDays: 30,
  /** ₹50,000. */
  maxCoverMinor: 5_000_000n,
}

/** ₹20,000 of cover — the amount a daily-wage earner actually buys. */
const COVER = 2_000_000n

const ACCOUNTS: InsuranceAccounts = {
  wallet: 'wallet',
  suspense: 'suspense',
  float: 'float',
}

/** A SHAP factor set for somebody with steady wages and low obligations. */
const GOOD_BEHAVIOUR = { favourable: [0.6, 0.4], adverse: [-0.2, -0.3] }
/** And for somebody with volatile cash flow and bounced payments. */
const POOR_BEHAVIOUR = { favourable: [-0.4, -0.3], adverse: [0.6, 0.5] }

/** Price one applicant end to end, the way `UnderwritingService` does. */
function priceFor(params: {
  bandBps: number
  confidence: number | null
  behaviour: { favourable: number[]; adverse: number[] }
}) {
  const breakdown = effectiveMultiplierBps({
    bandBps: params.bandBps,
    confidencePenaltyBps: confidencePenaltyBps(params.confidence),
    behaviourBps: behaviourNudgeBps(params.behaviour),
  })
  const quote = computePremium({
    coverageMinor: COVER,
    baseRateBps: INCOME_PROTECTION.baseRateBps,
    multiplierBps: breakdown.effectiveBps,
    termDays: INCOME_PROTECTION.termDays,
  })
  return { breakdown, ...quote }
}

function net(postings: Posting[]): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const posting of postings) {
    const signed =
      posting.direction === 'DEBIT' ? -posting.amountMinor : posting.amountMinor
    totals.set(posting.currency, (totals.get(posting.currency) ?? 0n) + signed)
  }
  return totals
}

function movement(postings: Posting[], accountId: string): bigint {
  return postings
    .filter((posting) => posting.accountId === accountId)
    .reduce(
      (total, posting) =>
        posting.direction === 'DEBIT'
          ? total - posting.amountMinor
          : total + posting.amountMinor,
      0n,
    )
}

// ── 1. reputation pricing is real ───────────────────────────────────────────
console.log('\n1. REPUTATION PRICING — the same cover, four applicants\n')

const excellent = priceFor({
  bandBps: BAND_TIER_POLICY.EXCELLENT.multiplierBps,
  confidence: 0.92,
  behaviour: GOOD_BEHAVIOUR,
})
const good = priceFor({
  bandBps: BAND_TIER_POLICY.GOOD.multiplierBps,
  confidence: 0.85,
  behaviour: { favourable: [], adverse: [] },
})
const fair = priceFor({
  bandBps: BAND_TIER_POLICY.FAIR.multiplierBps,
  confidence: 0.8,
  behaviour: POOR_BEHAVIOUR,
})
const thin = priceFor({
  bandBps: THIN_FILE_POLICY.multiplierBps,
  confidence: null,
  behaviour: { favourable: [], adverse: [] },
})

console.log(
  `   EXCELLENT  ${rupees(excellent.premiumMinor).padStart(10)}/mo   (${excellent.breakdown.effectiveBps} bps)`,
)
console.log(
  `   GOOD       ${rupees(good.premiumMinor).padStart(10)}/mo   (${good.breakdown.effectiveBps} bps)  ← the standard rate`,
)
console.log(
  `   FAIR       ${rupees(fair.premiumMinor).padStart(10)}/mo   (${fair.breakdown.effectiveBps} bps)`,
)
console.log(
  `   THIN FILE  ${rupees(thin.premiumMinor).padStart(10)}/mo   (${thin.breakdown.effectiveBps} bps)\n`,
)

check(
  'an EXCELLENT applicant pays less than a GOOD one',
  excellent.premiumMinor < good.premiumMinor,
  `${rupees(excellent.premiumMinor)} vs ${rupees(good.premiumMinor)}`,
)
check(
  'a FAIR applicant pays more than a GOOD one',
  fair.premiumMinor > good.premiumMinor,
  `${rupees(fair.premiumMinor)} vs ${rupees(good.premiumMinor)}`,
)
check(
  'the EXCELLENT↔FAIR gap is material, not cosmetic',
  savingsBps(excellent.premiumMinor, fair.premiumMinor) >= 3_000,
  `${(savingsBps(excellent.premiumMinor, fair.premiumMinor) / 100).toFixed(1)}% cheaper`,
)
check(
  'the behaviour nudge moves the price in the right direction',
  behaviourNudgeBps(GOOD_BEHAVIOUR) < 0 &&
    behaviourNudgeBps(POOR_BEHAVIOUR) > 0,
  `good ${behaviourNudgeBps(GOOD_BEHAVIOUR)} bps · poor +${behaviourNudgeBps(POOR_BEHAVIOUR)} bps`,
)
check(
  'no applicant is ever priced below the floor',
  [excellent, good, fair, thin].every(
    (quote) => quote.breakdown.effectiveBps >= MIN_MULTIPLIER_BPS,
  ),
)

// ── 2. the adverse-selection controls ───────────────────────────────────────
console.log('\n2. ADVERSE SELECTION — the four controls\n')

check(
  'a thin file is priced conservatively, not refused',
  thin.premiumMinor > good.premiumMinor,
  `${rupees(thin.premiumMinor)} vs ${rupees(good.premiumMinor)} — but still QUOTED`,
)
check(
  'a thin file waits longer before cover starts',
  THIN_FILE_POLICY.extraWaitingDays > 0,
  `${INCOME_PROTECTION.waitingPeriodDays} + ${THIN_FILE_POLICY.extraWaitingDays} days`,
)
check(
  'a SUBSTANDARD risk cannot buy the maximum cover',
  tierCoverCeilingMinor('SUBSTANDARD', INCOME_PROTECTION.maxCoverMinor) <
    INCOME_PROTECTION.maxCoverMinor,
  `${rupees(tierCoverCeilingMinor('SUBSTANDARD', INCOME_PROTECTION.maxCoverMinor))} of ${rupees(INCOME_PROTECTION.maxCoverMinor)}`,
)
check(
  'thin evidence costs basis points rather than being ignored',
  confidencePenaltyBps(0.3) > confidencePenaltyBps(0.9),
  `+${confidencePenaltyBps(0.3)} bps at 30% confidence, +${confidencePenaltyBps(0.9)} at 90%`,
)
check(
  'the POOR band is declined rather than sold unaffordable cover',
  BAND_TIER_POLICY.POOR.tier === 'DECLINE',
)

// ── 3. money is conserved ───────────────────────────────────────────────────
console.log('\n3. THE LEDGER — money is conserved on every path\n')

const premium = good.premiumMinor
/** An ₹8,000 approved wage-loss claim. */
const payout = 800_000n

const collect = [
  ...premiumReservePlan(ACCOUNTS, 'INR', premium),
  ...premiumEarnPlan(ACCOUNTS, 'INR', premium),
]
const claim = [
  ...claimReservePlan(ACCOUNTS, 'INR', payout),
  ...claimPayoutPlan(ACCOUNTS, 'INR', payout),
]
const refund = premiumRefundPlan(ACCOUNTS, 'INR', premium, 'premium-1')

for (const [label, postings] of [
  ['premium collection', collect],
  ['claim payout', claim],
  ['free-look refund', refund],
] as const) {
  check(
    `${label} balances per currency`,
    [...net(postings).values()].every((balance) => balance === 0n),
  )
}

check(
  'a premium leaves the wallet and lands in the float',
  movement(collect, ACCOUNTS.wallet) === -premium &&
    movement(collect, ACCOUNTS.float) === premium,
  `wallet ${rupees(premium)} → float`,
)
check(
  'suspense is a waypoint, never a destination',
  movement(collect, ACCOUNTS.suspense) === 0n &&
    movement(claim, ACCOUNTS.suspense) === 0n,
)
check(
  'a claim leaves the float and lands in the claimant’s wallet',
  movement(claim, ACCOUNTS.float) === -payout &&
    movement(claim, ACCOUNTS.wallet) === payout,
  `float ${rupees(payout)} → wallet`,
)

const wholeLife = [...collect, ...refund]
check(
  'collect-then-refund leaves every account exactly as it was',
  // Listed, not `Object.values` — that returns `any[]` on an interface with named
  // keys, which would leave the strongest assertion in this file unchecked.
  [ACCOUNTS.wallet, ACCOUNTS.suspense, ACCOUNTS.float].every(
    (account) => movement(wholeLife, account) === 0n,
  ),
)

const book = [...collect, ...claim]
check(
  'a claim larger than the book drives the float NEGATIVE rather than blocking',
  movement(book, ACCOUNTS.float) < 0n,
  `float ${rupees(-movement(book, ACCOUNTS.float))} short — an underwriting loss, visibly`,
)

const ratio = lossRatioBps(payout, premium)
check(
  'the loss ratio reports over 100% instead of clamping',
  ratio !== null && ratio > 10_000,
  ratio === null ? 'null' : `${(ratio / 100).toFixed(1)}%`,
)
check(
  'an empty book has NO loss ratio rather than 0%',
  lossRatioBps(0n, 0n) === null,
)

// ── 4. the waiting period ───────────────────────────────────────────────────
console.log('\n4. THE WAITING PERIOD — the control cannot be walked around\n')

const policy = {
  status: 'ACTIVE' as const,
  startAt: new Date('2026-05-01T00:00:00.000Z'),
  endAt: new Date('2027-05-01T00:00:00.000Z'),
  waitingPeriodEndsAt: new Date('2026-05-31T00:00:00.000Z'),
}
const insideWait = new Date('2026-05-15T00:00:00.000Z')
const afterWait = new Date('2026-07-01T00:00:00.000Z')

check(
  'an incident inside the waiting period is not covered',
  coverageRefusalFor(policy, insideWait, afterWait) === 'WITHIN_WAITING_PERIOD',
)
check(
  'filing late does NOT convert it into a covered incident',
  coverageRefusalFor(policy, insideWait, addDays(insideWait, 45)) ===
    'WITHIN_WAITING_PERIOD',
  'the guard compares the incident date, never the filing date',
)
check(
  'an incident after the waiting period IS covered',
  coverageRefusalFor(policy, afterWait, addDays(afterWait, 3)) === null,
)
check(
  'a lapsed policy covers nothing, whenever the incident happened',
  coverageRefusalFor({ ...policy, status: 'LAPSED' }, afterWait, afterWait) ===
    'POLICY_NOT_LIVE',
)

// ── 5. the tamper gate ──────────────────────────────────────────────────────
console.log('\n5. THE TAMPER GATE — a forged document is a hard block\n')

/** Mirrors the auto-approve condition in `ClaimsService.finalise`. */
function autoApproves(params: {
  amountMinor: bigint
  riskScore: number
  tamperScore: number
  docsVerified: boolean
}): boolean {
  const ceiling = AUTO_APPROVE_CEILING_MINOR.INR ?? 0n
  return (
    params.amountMinor <= ceiling &&
    params.riskScore < CLAIM_AUTO_APPROVE_RISK_CEILING &&
    params.tamperScore < TAMPER_BLOCK_THRESHOLD &&
    params.docsVerified
  )
}

/** ₹400 — a small, clean, low-risk claim. */
const smallClean = {
  amountMinor: 40_000n,
  riskScore: 0.1,
  tamperScore: 0.05,
  docsVerified: true,
}

check(
  'a small, clean, low-risk claim auto-approves',
  autoApproves(smallClean),
  'settled in seconds — which for this claimant is the product working',
)
check(
  'ONE forged document blocks it, on its own',
  !autoApproves({ ...smallClean, tamperScore: 0.92 }),
  'not averaged against the other favourable signals',
)
check(
  'a high fraud score blocks it',
  !autoApproves({ ...smallClean, riskScore: 0.55 }),
)
check(
  'an unverified document blocks it',
  !autoApproves({ ...smallClean, docsVerified: false }),
)
check(
  'a claim over the ceiling always sees a human',
  !autoApproves({ ...smallClean, amountMinor: 500_000n }),
  `ceiling ${rupees(AUTO_APPROVE_CEILING_MINOR.INR ?? 0n)}`,
)

// ── verdict ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n❌ M5 self-check FAILED — ${failures} assertion(s)\n`)
  process.exit(1)
}
console.log('\n✅ M5 self-check passed — all 5 claims hold\n')
