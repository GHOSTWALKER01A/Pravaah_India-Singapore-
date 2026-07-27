
/**
 * M2 scoring self-check — no database, no network, no Python.
 *
 *   npx tsx scripts/verify-scoring.ts
 *
 * Verifies the four claims M2 rests on, so a regression in the model maths is
 * caught here rather than in front of a user:
 *
 *   1. SHAP ADDITIVITY — the contributions shown in "why this score" must sum
 *      exactly to the margin. If this drifts, the explanation is no longer an
 *      explanation of the number next to it.
 *   2. ANTI-GAMING — a parked lump sum must not out-score a genuine saver.
 *   3. HONEST CONFIDENCE — a thin file must produce a visibly wider band.
 *   4. THE FAIRNESS GATE — the seeded cohort must fail the balance-weighted
 *      legacy model on age and pass the trend-weighted one. If both pass, the
 *      gate demo proves nothing.
 */
import {
  FEATURE_LABELS,
  MODEL_CATALOG,
  SCORECARD_V0_9,
  SCORECARD_V1,
} from '../src/modules/scoring/model-catalog'
import {
  applyTransform,
  bandFor,
  computeConfidence,
  confidenceBand,
  FEATURE_KEYS,
  hasEnoughData,
  probabilityToScore,
  sigmoid,
} from '../src/modules/scoring/scoring.state'

import type { ScorecardParamsDto, ScoreFeature } from '@pravaah/schema'

type Vec = Record<ScoreFeature, number | null>

const OPTIONAL = new Set<ScoreFeature>([
  'gst_turnover',
  'gst_filing_consistency',
])

/** Mirrors LocalScorecardProvider.run exactly — same helpers, same order. */
function run(params: ScorecardParamsDto, features: Vec, coverage: number) {
  const { a, b } = params.calibration
  let margin = a * params.intercept + b
  let base = a * params.intercept + b
  let missingRequired = 0
  let requiredCount = 0
  const contribs: { feature: ScoreFeature; shap: number }[] = []

  for (const key of FEATURE_KEYS) {
    const transform = params.transforms[key]
    if (!transform) continue
    const weight = params.weights[key] ?? 0
    const reference = params.reference[key] ?? 0
    const optional = OPTIONAL.has(key)
    if (!optional) requiredCount++

    const raw = features[key]
    const missing = raw === null || !Number.isFinite(raw)
    if (missing && !optional) missingRequired++
    const value = missing ? reference : raw!

    const term = a * weight * applyTransform(value, transform)
    const refTerm = a * weight * applyTransform(reference, transform)
    margin += term
    base += refTerm
    contribs.push({ feature: key, shap: term - refTerm })
  }

  const p = sigmoid(margin)
  const score = probabilityToScore(p)
  const conf = computeConfidence({
    coverage,
    probability: p,
    missingRequired,
    requiredCount,
  })
  contribs.sort((x, y) => Math.abs(y.shap) - Math.abs(x.shap))
  return {
    score,
    band: bandFor(score),
    margin,
    base,
    conf,
    contribs,
    interval: confidenceBand(score, conf.confidence),
  }
}

let failures = 0
const check = (ok: boolean, label: string) => {
  if (!ok) failures++
  console.log(`  ${ok ? '✔' : '✗ FAIL'}  ${label}`)
}

// ── 1. SHAP additivity ──────────────────────────────────────────────────────
console.log('\n1. SHAP additivity — margin must equal base + Σφᵢ exactly')
const arjun: Vec = {
  monthly_inflow: 85_000,
  income_regularity: 1.0,
  avg_balance: 300_000,
  balance_retention: 0.9,
  obligation_ratio: 0.624,
  months_covered: 12,
  bounce_count: 1,
  gst_turnover: 4_820_000,
  gst_filing_consistency: 0.958,
}
const a1 = run(SCORECARD_V1, arjun, 0.935)
const sum = a1.contribs.reduce((s, c) => s + c.shap, 0)
const residual = Math.abs(a1.margin - (a1.base + sum))
console.log(`     margin ${a1.margin.toFixed(10)}   base+Σφ ${(a1.base + sum).toFixed(10)}`)
check(residual < 1e-9, `residual ${residual.toExponential(2)} < 1e-9`)

console.log(`\n     Demo profile → ${a1.score} / ${a1.band}, confidence ${a1.conf.confidence} (${a1.interval.low}–${a1.interval.high})`)
console.log(`     coverage=${a1.conf.coverage}  certainty=${a1.conf.certainty}  completeness=${a1.conf.completeness}`)
for (const c of a1.contribs.slice(0, 5)) {
  const sign = c.shap >= 0 ? '+' : '−'
  console.log(`       ${sign} ${FEATURE_LABELS[c.feature].padEnd(32)} ${c.shap.toFixed(4)}`)
}
check(
  a1.contribs.some((c) => c.feature === 'bounce_count' && c.shap < 0),
  'the seeded bounce shows up as a NEGATIVE driver',
)

// ── 2. anti-gaming ──────────────────────────────────────────────────────────
console.log('\n2. Anti-gaming — a parked lump sum must not beat a genuine saver')
const base: Vec = { ...arjun, gst_turnover: null, gst_filing_consistency: null }
const saver: Vec = { ...base, avg_balance: 120_000, balance_retention: 0.92 }
const parker: Vec = { ...base, avg_balance: 480_000, balance_retention: 0.12 }
const s1 = run(SCORECARD_V1, saver, 0.87)
const p1 = run(SCORECARD_V1, parker, 0.87)
const s0 = run(SCORECARD_V0_9, saver, 0.87)
const p0 = run(SCORECARD_V0_9, parker, 0.87)
console.log(`     v1.0.0 (trend-weighted)   saver ${s1.score} ${s1.band}   parker ${p1.score} ${p1.band}`)
console.log(`     v0.9.0 (balance-weighted) saver ${s0.score} ${s0.band}   parker ${p0.score} ${p0.band}`)
check(s1.score > p1.score, 'v1.0.0 ranks the saver above the parker')
check(
  p0.score > s0.score,
  'v0.9.0 IS gameable — kept registered as the cautionary exhibit',
)

// ── 3. honest confidence ────────────────────────────────────────────────────
console.log('\n3. Honest confidence — a thin file must widen the band visibly')
const thin: Vec = {
  monthly_inflow: 48_000,
  income_regularity: null,
  avg_balance: 8_000,
  balance_retention: null,
  obligation_ratio: null,
  months_covered: 2,
  bounce_count: 0,
  gst_turnover: null,
  gst_filing_consistency: null,
}
const t1 = run(SCORECARD_V1, thin, 0.28)
console.log(`     thin  ${t1.score} ${t1.band}  confidence ${t1.conf.confidence}  band ±${t1.interval.halfWidth} (${t1.interval.low}–${t1.interval.high})`)
console.log(`     full  ${a1.score} ${a1.band}  confidence ${a1.conf.confidence}  band ±${a1.interval.halfWidth} (${a1.interval.low}–${a1.interval.high})`)
check(t1.interval.halfWidth > a1.interval.halfWidth * 1.5, 'thin file gets a materially wider band')
check(hasEnoughData(thin), 'a 2-month file with inflow clears the minimum gate')
check(
  !hasEnoughData({ ...thin, months_covered: 1, monthly_inflow: 0 }),
  'a 1-month, no-inflow file is refused (INSUFFICIENT_DATA)',
)
// A salaried user must not be penalised for having no business record.
const salaried = run(SCORECARD_V1, base, 0.87)
check(
  salaried.conf.completeness === 1,
  'no GST file ⇒ completeness stays 1.0 (not-applicable, not missing)',
)

// ── 4. the fairness gate ────────────────────────────────────────────────────
console.log('\n4. Fairness gate — over the seeded 200-subject cohort')

const AGE_MONTHS: Record<string, [number, number]> = {
  '18-25': [3, 9],
  '26-35': [7, 18],
  '36-45': [11, 24],
  '46-60': [16, 24],
  '60+': [20, 24],
}
const GENDERS = ['female', 'male', 'other', 'prefer_not_to_say']
const AGES = ['18-25', '26-35', '36-45', '46-60', '60+']
const NATS = ['IN', 'SG']

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}
const rand = mulberry32(0x9e3779b9)
const bt = (lo: number, hi: number) => lo + rand() * (hi - lo)
const r3 = (n: number) => Number(n.toFixed(3))

const COHORT_SIZE = 200
const cohort = Array.from({ length: COHORT_SIZE }, (_, i) => {
  const gender = GENDERS[i % GENDERS.length]!
  const ageBand = AGES[i % AGES.length]!
  const nationality = NATS[i % NATS.length]!
  const ageIndex = AGES.indexOf(ageBand) / (AGES.length - 1)

  // History depth IS near-deterministic in age — you cannot hold two years of
  // statements at nineteen. That correlation stays.
  const monthsCovered = Math.round(bt(...AGE_MONTHS[ageBand]!))

  // Earning power is INDEPENDENT of age. Real populations contain well-paid
  // 23-year-olds and struggling 50-year-olds; a round-robin that makes age band
  // determine income is a caricature, and auditing a caricature tells you
  // nothing about the model.
  const earningPower = bt(0.15, 1.0)
  const ageWage = ageBand === '60+' ? 0.35 : ageIndex // pensions, not peak salary
  const wageIndex = 0.35 * ageWage + 0.65 * earningPower
  const monthlyIncome = Math.round(20_000 + wageIndex * 180_000)
  // Savings accumulate with age (a 55-year-old on the same salary has years of
  // surplus behind them). The RANDOM spread is deliberately much wider than the
  // age spread, because savings rate varies enormously between people on
  // identical incomes — a cohort where age nearly determines balance would be a
  // caricature.
  //
  // The GENDER term encodes a real, documented pattern rather than an invented
  // one: women in India hold materially lower average account balances than men
  // at comparable incomes (unpaid care work, joint-account dynamics, and lower
  // asset titling all contribute). Their repayment BEHAVIOUR is at least as good
  // — the microfinance literature is unambiguous on that. So `avg_balance` is a
  // gender PROXY while behaviour features are not, which is exactly why a
  // balance-weighted model launders gender and a behaviour-weighted one does not.
  // This is the mechanism the activation gate exists to catch.
  const balanceByGender: Record<string, number> = {
    female: 0.52,
    other: 0.85,
    prefer_not_to_say: 0.9,
    male: 1.0,
  }
  const avgBalance = Math.round(
    monthlyIncome *
      bt(0.3, 3.5) *
      (0.6 + 1.2 * ageIndex) *
      (balanceByGender[gender] ?? 1),
  )

  // Behaviour is at PARITY for the group with lower balances — a small edge, not
  // a large one. Overstating it would flip the disparity the other way and make
  // the audit measure the fixture rather than the model.
  const behaviourEdge = gender === 'female' ? 0.02 : 0
  const incomeRegularity = r3(Math.min(0.98, bt(0.6, 0.97) + behaviourEdge))
  const balanceRetention = r3(Math.min(0.98, bt(0.35, 0.95) + behaviourEdge))
  const obligationRatio = r3(Math.max(0.2, bt(0.4, 1.05) - behaviourEdge))
  const bounceCount = rand() < 0.3 ? (rand() < 0.4 ? 2 : 1) : 0
  return {
    gender,
    ageBand,
    nationality,
    coverage: r3(
      0.5 * Math.min(1, (monthsCovered * 3) / 50) +
        0.5 * Math.min(1, monthsCovered / 6),
    ),
    features: {
      monthly_inflow: monthlyIncome,
      income_regularity: incomeRegularity,
      avg_balance: avgBalance,
      balance_retention: balanceRetention,
      obligation_ratio: obligationRatio,
      months_covered: monthsCovered,
      bounce_count: bounceCount,
      gst_turnover: null,
      gst_filing_consistency: null,
    } as Vec,
  }
})

/** Attributes that can BLOCK an activation. Mirrors FairnessService. */
const BLOCKING = new Set(['gender', 'nationality'])

/** Two-sided normal critical value at α = 0.05. Mirrors FairnessService. */
const Z_CRIT = 1.959964

/** Pooled two-proportion z-test. Mirrors twoProportionZ in FairnessService. */
function twoProportionZ(
  group: readonly number[],
  reference: readonly number[],
): { z: number; significant: boolean } {
  const n1 = group.length
  const n2 = reference.length
  if (n1 === 0 || n2 === 0) return { z: 0, significant: false }
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const pooled = (sum(group) + sum(reference)) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (se < 1e-12) return { z: 0, significant: false }
  const z = (sum(group) / n1 - sum(reference) / n2) / se
  return { z, significant: Math.abs(z) >= Z_CRIT }
}

const verdicts = new Map<string, boolean>()
const concerns = new Map<string, boolean>()
for (const entry of MODEL_CATALOG) {
  if (!entry.scorecard) continue
  const approved = new Map<string, number[]>()
  const scores: number[] = []
  let total = 0
  for (const s of cohort) {
    const out = run(entry.scorecard, s.features, s.coverage)
    scores.push(out.score)
    const ok = out.score >= 670 ? 1 : 0
    total += ok
    for (const g of [
      `gender:${s.gender}`,
      `age_band:${s.ageBand}`,
      `nationality:${s.nationality}`,
    ]) {
      approved.set(g, [...(approved.get(g) ?? []), ok])
    }
  }
  const popRate = total / cohort.length
  scores.sort((x, y) => x - y)
  console.log(`\n   v${entry.version}  p10/50/90 = ${scores[Math.floor(COHORT_SIZE*0.1)]}/${scores[Math.floor(COHORT_SIZE*0.5)]}/${scores[Math.floor(COHORT_SIZE*0.9)]}   approval ${(popRate * 100).toFixed(0)}%`)

  const byAttr = new Map<string, string[]>()
  for (const g of approved.keys()) {
    const attr = g.split(':')[0]!
    byAttr.set(attr, [...(byAttr.get(attr) ?? []), g])
  }
  let blockingFailed = false
  let monitoredConcern = false
  for (const [attr, groups] of byAttr) {
    const blocking = BLOCKING.has(attr)
    const rates = new Map(
      groups.map((g) => {
        const o = approved.get(g)!
        return [g, o.reduce((x, y) => x + y, 0) / o.length] as const
      }),
    )
    const best = Math.max(...rates.values())
    const bestGroup = groups.reduce(
      (w, g) => ((rates.get(g) ?? 0) > (rates.get(w) ?? 0) ? g : w),
      groups[0]!,
    )
    for (const g of [...groups].sort()) {
      const rate = rates.get(g)!
      const outcomes = approved.get(g)!
      const n = outcomes.length
      const di = best > 0 ? rate / best : 1
      const gap = Math.abs(rate - popRate)
      const small = n < 30

      // Disparate impact is tested against the best group; parity against the
      // group's complement. Both need the gap to be statistically real, not just
      // large — the ratio alone fires on sampling noise at small n.
      const diSig =
        bestGroup !== g
          ? twoProportionZ(outcomes, approved.get(bestGroup)!).significant
          : false
      const dpSig = twoProportionZ(
        outcomes,
        groups.filter((o) => o !== g).flatMap((o) => approved.get(o)!),
      ).significant

      const diOk = small || di >= 0.8 || !diSig
      const dpOk = small || gap <= 0.1 || !dpSig
      if (!diOk || !dpOk) {
        if (blocking) blockingFailed = true
        else monitoredConcern = true
      }
      const tag = small
        ? '  (small — reported, not decisive)'
        : blocking
          ? ''
          : '  (monitored, not blocking)'
      console.log(
        `     ${g.padEnd(26)} n=${String(n).padStart(3)} rate=${rate.toFixed(2)}  DI=${di.toFixed(2)}${diOk ? ' ' : '✗'}  gap=${gap.toFixed(2)}${dpOk ? ' ' : '✗'}${tag}`,
      )
    }
  }
  verdicts.set(entry.version, !blockingFailed)
  concerns.set(entry.version, monitoredConcern)
  console.log(
    `     → gate: ${blockingFailed ? 'FAILED (activation blocked)' : 'PASSED'}` +
      `${monitoredConcern ? '   · monitored age gap present — reported, not blocking' : ''}`,
  )
}

console.log()
check(
  verdicts.get('1.0.0') === true,
  'v1.0.0 (behaviour-weighted) PASSES the gate on gender + nationality',
)
check(
  verdicts.get('0.9.0') === false,
  'v0.9.0 (balance-weighted) FAILS the gate — bias found without ever seeing an attribute',
)
check(
  concerns.get('1.0.0') === true || concerns.get('0.9.0') === true,
  'the age gap is still REPORTED as a monitored concern, never hidden',
)

console.log(
  failures === 0
    ? '\n✅ All M2 scoring invariants hold.\n'
    : `\n❌ ${failures} check(s) failed.\n`,
)
process.exit(failures === 0 ? 0 : 1)
