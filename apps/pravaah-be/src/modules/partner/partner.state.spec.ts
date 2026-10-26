import type { PredicateSpec } from '@pravaah/schema'

import {
  PartnerRole,
  PartnerStatus,
  PartnerUsageKind,
} from 'generated/prisma/client'

import {
  PredicateError,
  answeredPredicateKeys,
  billingPeriod,
  canPartnerTransition,
  compilePredicate,
  compilePredicates,
  evaluatePredicates,
  type CompiledPredicate,
  isBillable,
  isRedacted,
  predicateClaims,
  projectResultForPartner,
  readCompiledPredicates,
  recentPeriods,
  redactResult,
  roleAtLeast,
  webhookBackoffMs,
} from '@/modules/partner/partner.state'

/**
 * The pure rules of M7. Each block pins a property that, if it regressed, would
 * either leak data (predicates, projection, redaction), bill wrongly (metering), or
 * let a partner do something an admin did not allow (lifecycle, roles).
 */

/** The four issuer-minted booleans for a holder in `band`, exactly as M3 mints them. */
function thresholdsFor(
  band: 'POOR' | 'FAIR' | 'GOOD' | 'VERY_GOOD' | 'EXCELLENT',
) {
  const rank = ['POOR', 'FAIR', 'GOOD', 'VERY_GOOD', 'EXCELLENT'].indexOf(band)
  return {
    score_at_least_fair: rank >= 1,
    score_at_least_good: rank >= 2,
    score_at_least_very_good: rank >= 3,
    score_at_least_excellent: rank >= 4,
  }
}

const BANDS = ['POOR', 'FAIR', 'GOOD', 'VERY_GOOD', 'EXCELLENT'] as const
const RANK = Object.fromEntries(BANDS.map((b, i) => [b, i])) as Record<
  (typeof BANDS)[number],
  number
>

describe('partner lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    expect(
      canPartnerTransition(
        PartnerStatus.PENDING_APPROVAL,
        PartnerStatus.ACTIVE,
      ),
    ).toBe(true)
    expect(
      canPartnerTransition(
        PartnerStatus.PENDING_APPROVAL,
        PartnerStatus.REVOKED,
      ),
    ).toBe(true)
    expect(
      canPartnerTransition(PartnerStatus.ACTIVE, PartnerStatus.SUSPENDED),
    ).toBe(true)
    expect(
      canPartnerTransition(PartnerStatus.SUSPENDED, PartnerStatus.ACTIVE),
    ).toBe(true)
    expect(
      canPartnerTransition(PartnerStatus.SUSPENDED, PartnerStatus.REVOKED),
    ).toBe(true)
  })

  it('never lets an applicant skip approval into SUSPENDED', () => {
    expect(
      canPartnerTransition(
        PartnerStatus.PENDING_APPROVAL,
        PartnerStatus.SUSPENDED,
      ),
    ).toBe(false)
  })

  it('treats REVOKED as terminal — a terminated audience is never resurrected', () => {
    for (const to of Object.values(PartnerStatus)) {
      expect(canPartnerTransition(PartnerStatus.REVOKED, to)).toBe(false)
    }
  })
})

describe('console role ladder', () => {
  it('is a strict ladder', () => {
    expect(
      roleAtLeast(PartnerRole.PARTNER_ADMIN, PartnerRole.PARTNER_ANALYST),
    ).toBe(true)
    expect(
      roleAtLeast(PartnerRole.PARTNER_ANALYST, PartnerRole.PARTNER_ANALYST),
    ).toBe(true)
    expect(
      roleAtLeast(PartnerRole.PARTNER_VIEWER, PartnerRole.PARTNER_ANALYST),
    ).toBe(false)
    expect(
      roleAtLeast(PartnerRole.PARTNER_ANALYST, PartnerRole.PARTNER_ADMIN),
    ).toBe(false)
  })
})

describe('predicate compilation', () => {
  it('compiles "band ≥ GOOD" to the single issuer-signed boolean that answers it', () => {
    const compiled = compilePredicate({
      claim: 'score_band',
      op: 'GTE',
      value: 'GOOD',
    })
    expect(compiled.key).toBe('score_band:GTE:GOOD')
    expect(compiled.clauses).toEqual([
      { claim: 'score_at_least_good', expect: true },
    ])
  })

  it('never needs more than two booleans, and never the band or the score', () => {
    for (const op of ['GTE', 'GT', 'LTE', 'LT', 'EQ'] as const) {
      for (const value of BANDS) {
        let compiled: CompiledPredicate
        try {
          compiled = compilePredicate({ claim: 'score_band', op, value })
        } catch {
          continue // trivial predicates are refused — covered below
        }
        expect(compiled.clauses.length).toBeGreaterThanOrEqual(1)
        expect(compiled.clauses.length).toBeLessThanOrEqual(2)
        for (const clause of compiled.clauses) {
          expect(clause.claim).toMatch(/^score_at_least_/)
        }
      }
    }
  })

  /**
   * The exhaustive truth table: for every operator, every threshold and every
   * holder band, the answer computed from the disclosed booleans must equal the
   * answer computed from the band itself. This is the property that makes a
   * predicate an honest substitute for disclosing the band.
   */
  it('answers every comparison exactly as the band would', () => {
    const truth: Record<string, (a: number, b: number) => boolean> = {
      GTE: (a, b) => a >= b,
      GT: (a, b) => a > b,
      LTE: (a, b) => a <= b,
      LT: (a, b) => a < b,
      EQ: (a, b) => a === b,
    }
    for (const op of Object.keys(truth) as PredicateSpec['op'][]) {
      for (const value of BANDS) {
        let compiled: CompiledPredicate
        try {
          compiled = compilePredicate({ claim: 'score_band', op, value })
        } catch {
          continue
        }
        for (const holder of BANDS) {
          const answer = evaluatePredicates([compiled], thresholdsFor(holder))[
            compiled.key
          ]
          expect({ op, value, holder, answer }).toEqual({
            op,
            value,
            holder,
            answer: truth[op](RANK[holder], RANK[value]),
          })
        }
      }
    }
  })

  it.each([
    ['GTE', 'POOR', 'true'],
    ['GT', 'EXCELLENT', 'false'],
    ['LT', 'POOR', 'false'],
    ['LTE', 'EXCELLENT', 'true'],
  ] as const)(
    'refuses %s %s — it is %s for every holder and proves nothing',
    (op, value, always) => {
      expect(() =>
        compilePredicate({ claim: 'score_band', op, value }),
      ).toThrow(
        new PredicateError(
          `Predicate score_band:${op}:${value} is ${always} for every holder and cannot be asked`,
          `score_band:${op}:${value}`,
        ),
      )
    },
  )

  it('de-duplicates repeated predicates', () => {
    const spec: PredicateSpec = {
      claim: 'score_band',
      op: 'GTE',
      value: 'GOOD',
    }
    expect(compilePredicates([spec, spec])).toHaveLength(1)
  })

  it('lists the threshold claims a set of predicates needs, once each', () => {
    const compiled = compilePredicates([
      { claim: 'score_band', op: 'GTE', value: 'GOOD' },
      { claim: 'score_band', op: 'EQ', value: 'GOOD' },
    ])
    expect(predicateClaims(compiled).sort()).toEqual(
      ['score_at_least_good', 'score_at_least_very_good'].sort(),
    )
  })
})

describe('predicate evaluation', () => {
  const compiled = compilePredicates([
    { claim: 'score_band', op: 'GTE', value: 'GOOD' },
  ])

  it('reports a WITHHELD claim as null, never as false', () => {
    // "Did not answer" is not "answered no" — reading it as false would decline an
    // excellent applicant who simply chose not to share.
    expect(evaluatePredicates(compiled, {})).toEqual({
      'score_band:GTE:GOOD': null,
    })
  })

  it('treats a non-boolean value as unanswered rather than truthy', () => {
    expect(
      evaluatePredicates(compiled, { score_at_least_good: 'true' }),
    ).toEqual({
      'score_band:GTE:GOOD': null,
    })
  })

  it('records as shared only the predicates the disclosure fully answers', () => {
    const eq = compilePredicates([
      { claim: 'score_band', op: 'EQ', value: 'GOOD' },
    ])
    expect(answeredPredicateKeys(eq, ['score_at_least_good'])).toEqual([])
    expect(
      answeredPredicateKeys(eq, [
        'score_at_least_good',
        'score_at_least_very_good',
      ]),
    ).toEqual(['score_band:EQ:GOOD'])
  })

  it('reads compiled predicates back from JSON defensively', () => {
    expect(readCompiledPredicates(null)).toEqual([])
    expect(readCompiledPredicates([{ nonsense: true }, 'x'])).toEqual([])
    expect(
      readCompiledPredicates(JSON.parse(JSON.stringify(compiled))),
    ).toEqual(compiled)
  })
})

describe('metering', () => {
  it('bills only successful verifications', () => {
    expect(isBillable(PartnerUsageKind.VERIFIED)).toBe(true)
    expect(isBillable(PartnerUsageKind.DIRECT_VERIFIED)).toBe(true)
    for (const kind of [
      PartnerUsageKind.REQUEST_CREATED,
      PartnerUsageKind.PRESENTATION_REJECTED,
      PartnerUsageKind.DECLINED,
      PartnerUsageKind.EXPIRED,
      PartnerUsageKind.CANCELLED,
      PartnerUsageKind.DIRECT_REJECTED,
    ]) {
      expect(isBillable(kind)).toBe(false)
    }
  })

  it('periods are UTC months, so an invoice never straddles a timezone', () => {
    // 23:30 IST on 31 Jan is 18:00 UTC — still January.
    expect(billingPeriod(new Date('2026-01-31T18:00:00Z'))).toBe('2026-01')
    expect(billingPeriod(new Date('2026-02-01T00:00:00Z'))).toBe('2026-02')
  })

  it('walks back across a year boundary', () => {
    expect(recentPeriods('2026-02', 4)).toEqual([
      '2026-02',
      '2026-01',
      '2025-12',
      '2025-11',
    ])
  })
})

describe('webhook backoff', () => {
  it('grows exponentially and is capped at six hours', () => {
    expect(webhookBackoffMs(1, 0.5)).toBe(30_000)
    expect(webhookBackoffMs(2, 0.5)).toBe(60_000)
    expect(webhookBackoffMs(3, 0.5)).toBe(120_000)
    expect(webhookBackoffMs(30, 0.5)).toBe(6 * 60 * 60_000)
  })

  it('spreads retries ±20% so a recovered endpoint is not stampeded', () => {
    expect(webhookBackoffMs(2, 0)).toBe(48_000)
    expect(webhookBackoffMs(2, 1)).toBe(72_000)
  })
})

describe('redaction and projection', () => {
  const cached = {
    valid: true,
    holderVerified: true,
    replayProtected: true,
    claims: {
      score_scale: '300-900',
      score_at_least_good: true,
      given_name: 'Arjun',
      birth_date: '1990-01-01',
    },
    claimLabels: {
      score_at_least_good: 'Good or better',
      given_name: 'First name',
      birth_date: 'Date of birth',
    },
    withheldClaims: [],
  }

  it('strips claim values but keeps the verdict and the names to delete', () => {
    const redacted = redactResult(
      cached,
      'CONSENT_WITHDRAWN',
      new Date('2026-09-01T00:00:00Z'),
    )
    expect(redacted.claims).toEqual({})
    expect(redacted.claimLabels).toEqual({})
    expect(redacted.valid).toBe(true)
    expect(redacted.holderVerified).toBe(true)
    expect(redacted.redactedClaimNames).toEqual(Object.keys(cached.claims))
    expect(isRedacted(redacted)).toBe(true)
    expect(isRedacted(cached)).toBe(false)
  })

  it('re-filters claims to the partner’s CURRENT scope', () => {
    const compiled = compilePredicates([
      { claim: 'score_band', op: 'GTE', value: 'GOOD' },
    ])
    const view = projectResultForPartner(cached, compiled, [
      'score_at_least_good',
      'given_name',
    ])!
    expect(view.claims).toEqual({
      score_scale: '300-900',
      score_at_least_good: true,
      given_name: 'Arjun',
    })
    expect(view.claimLabels).not.toHaveProperty('birth_date')
    expect(view.predicates).toEqual({ 'score_band:GTE:GOOD': true })
  })

  it('does not leak a predicate answer over a claim that has left scope', () => {
    const compiled = compilePredicates([
      { claim: 'score_band', op: 'GTE', value: 'GOOD' },
    ])
    const view = projectResultForPartner(cached, compiled, ['given_name'])!
    expect(view.claims).not.toHaveProperty('score_at_least_good')
    expect(view.predicates).toEqual({ 'score_band:GTE:GOOD': null })
  })

  it('returns null for a request with no result yet', () => {
    expect(projectResultForPartner(null, [], [])).toBeNull()
  })
})
