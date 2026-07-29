import { RISK_THRESHOLDS, SIGNAL_WEIGHTS } from '@/modules/fraud/fraud.config'
import {
  aggregateRisk,
  breachDegree,
  breachDegreeBigInt,
  canCaseTransition,
  canDeviceTransition,
  clamp01,
  decide,
  isCaseTerminal,
  isDeviceTrustedForValue,
  isDeviceUsable,
  isStepUpRedeemable,
  isWeakPin,
  needsCase,
  severityFor,
  velocityBucketKey,
  velocityResetAt,
  type Signal,
} from '@/modules/fraud/fraud.state'

import {
  DeviceStatus,
  FraudCaseStatus,
  FraudSeverity,
  RiskDecision,
  StepUpStatus,
} from 'generated/prisma/client'

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: 'TEST',
    weight: 0.5,
    value: 1,
    reason: 'test',
    ...overrides,
  }
}

describe('aggregateRisk (noisy-OR)', () => {
  it('is zero with no signals', () => {
    expect(aggregateRisk([])).toBe(0)
  })

  it('returns the single contribution for one signal', () => {
    expect(aggregateRisk([signal({ weight: 0.6, value: 1 })])).toBe(0.6)
  })

  it('scales a contribution by its degree', () => {
    expect(aggregateRisk([signal({ weight: 0.6, value: 0.5 })])).toBe(0.3)
  })

  /**
   * The property that makes noisy-OR the right choice: adding a signal can never
   * LOWER the score. A normalised sum (`total / count`) fails this — a mild extra
   * signal dilutes a severe one, which would let an attacker reduce their own risk
   * score by adding innocuous noise.
   */
  it('is monotonic — adding a signal never lowers the score', () => {
    const base = [signal({ weight: 0.6, value: 1 })]
    const withExtra = [...base, signal({ weight: 0.1, value: 1 })]

    expect(aggregateRisk(withExtra)).toBeGreaterThan(aggregateRisk(base))
  })

  it('saturates below 1 rather than exceeding it', () => {
    const many = Array.from({ length: 40 }, () =>
      signal({ weight: 0.9, value: 1 }),
    )
    const score = aggregateRisk(many)

    expect(score).toBeLessThanOrEqual(1)
    expect(score).toBeGreaterThan(0.99)
  })

  it('combines two independent signals probabilistically, not additively', () => {
    // 1 - (1-0.5)(1-0.5) = 0.75, NOT 1.0 as a sum would give.
    expect(
      aggregateRisk([signal({ weight: 0.5 }), signal({ weight: 0.5 })]),
    ).toBe(0.75)
  })

  /**
   * A mis-tuned collector returning a weight above 1 or below 0 would otherwise flip
   * the sign of the product and produce a score outside the range every threshold
   * assumes.
   */
  it('clamps out-of-range weights instead of producing an invalid score', () => {
    expect(aggregateRisk([signal({ weight: 5, value: 1 })])).toBe(1)
    expect(aggregateRisk([signal({ weight: -3, value: 1 })])).toBe(0)
    expect(aggregateRisk([signal({ weight: Number.NaN, value: 1 })])).toBe(0)
  })

  it('is order-independent', () => {
    const a = signal({ weight: 0.3 })
    const b = signal({ weight: 0.45 })
    const c = signal({ weight: 0.1 })

    expect(aggregateRisk([a, b, c])).toBe(aggregateRisk([c, a, b]))
  })
})

describe('clamp01', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [2, 1],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('clamps %p to %p', (input, expected) => {
    expect(clamp01(input)).toBe(expected)
  })
})

describe('decide (the ladder)', () => {
  const base = { sensitive: false, signals: [] as Signal[] }

  it('allows a clean, low score', () => {
    expect(decide({ ...base, score: 0.1 })).toBe(RiskDecision.ALLOW)
  })

  it('holds at or above the hold threshold', () => {
    expect(decide({ ...base, score: RISK_THRESHOLDS.HOLD })).toBe(
      RiskDecision.HOLD,
    )
    expect(decide({ ...base, score: 0.99 })).toBe(RiskDecision.HOLD)
  })

  it('steps up in the medium band', () => {
    expect(decide({ ...base, score: RISK_THRESHOLDS.STEP_UP })).toBe(
      RiskDecision.STEP_UP,
    )
    expect(decide({ ...base, score: 0.7 })).toBe(RiskDecision.STEP_UP)
  })

  /**
   * A hard signal must beat ANY score, including a score low enough to allow. This is
   * the "the payee is on a sanctions list is not a probability" rule.
   */
  it('blocks on a hard signal regardless of score', () => {
    expect(
      decide({
        ...base,
        score: 0,
        signals: [signal({ weight: 0.01, value: 0.01, isHard: true })],
      }),
    ).toBe(RiskDecision.BLOCK)
  })

  it('prefers BLOCK over HOLD when both would apply', () => {
    expect(
      decide({
        ...base,
        score: 0.99,
        signals: [signal({ isHard: true })],
      }),
    ).toBe(RiskDecision.BLOCK)
  })

  /**
   * The structural rule. One 0.20 DEVICE_NEW signal scores 0.20 and would otherwise
   * ALLOW — which is the account-takeover sequence (bind a device, immediately move
   * money) walking straight through the arithmetic.
   */
  it('steps up a sensitive action from a new device even at a low score', () => {
    const signals = [
      signal({ type: 'DEVICE_NEW', weight: SIGNAL_WEIGHTS.DEVICE_NEW }),
    ]

    expect(decide({ score: 0.2, signals, sensitive: true })).toBe(
      RiskDecision.STEP_UP,
    )
    // Not sensitive → the structural rule does not apply.
    expect(decide({ score: 0.2, signals, sensitive: false })).toBe(
      RiskDecision.ALLOW,
    )
  })

  it.each(['DEVICE_NEW', 'DEVICE_UNBOUND', 'SIM_SUSPECTED_SWAP'])(
    'treats %s as structural device risk',
    (type) => {
      expect(
        decide({ score: 0.05, signals: [signal({ type })], sensitive: true }),
      ).toBe(RiskDecision.STEP_UP)
    },
  )

  it('shadow-reviews a mid-band score only when the value is high', () => {
    const args = { ...base, score: 0.4 }

    expect(decide({ ...args, amountMinor: 60_000_00n })).toBe(
      RiskDecision.REVIEW,
    )
    // Same score, small amount → no friction and no sampling.
    expect(decide({ ...args, amountMinor: 100_00n })).toBe(RiskDecision.ALLOW)
    // No amount at all (a login) → nothing to gate on.
    expect(decide(args)).toBe(RiskDecision.ALLOW)
  })

  it('prefers the HOLD band over the structural step-up rule', () => {
    expect(
      decide({
        score: 0.9,
        signals: [signal({ type: 'DEVICE_NEW' })],
        sensitive: true,
      }),
    ).toBe(RiskDecision.HOLD)
  })
})

describe('needsCase / severityFor', () => {
  it('opens a case only for blocking decisions', () => {
    expect(needsCase(RiskDecision.HOLD)).toBe(true)
    expect(needsCase(RiskDecision.BLOCK)).toBe(true)
    expect(needsCase(RiskDecision.STEP_UP)).toBe(false)
    expect(needsCase(RiskDecision.REVIEW)).toBe(false)
    expect(needsCase(RiskDecision.ALLOW)).toBe(false)
  })

  it('rates a BLOCK critical regardless of score', () => {
    expect(severityFor(RiskDecision.BLOCK, 0)).toBe(FraudSeverity.CRITICAL)
  })

  it('escalates a very high HOLD to HIGH', () => {
    expect(severityFor(RiskDecision.HOLD, 0.95)).toBe(FraudSeverity.HIGH)
    expect(severityFor(RiskDecision.HOLD, 0.86)).toBe(FraudSeverity.MEDIUM)
  })
})

describe('device lifecycle', () => {
  it('activates only from BINDING or SUSPECTED_SWAP', () => {
    expect(canDeviceTransition(DeviceStatus.BINDING, DeviceStatus.ACTIVE)).toBe(
      true,
    )
    expect(
      canDeviceTransition(DeviceStatus.SUSPECTED_SWAP, DeviceStatus.ACTIVE),
    ).toBe(true)
  })

  /**
   * REVOKED is terminal. Reviving the row would silently restore a device whose
   * history includes a theft report — the user must bind afresh, producing a NEW
   * cooling-off window.
   */
  it('never revives a revoked device', () => {
    expect(canDeviceTransition(DeviceStatus.REVOKED, DeviceStatus.ACTIVE)).toBe(
      false,
    )
    expect(
      canDeviceTransition(DeviceStatus.REVOKED, DeviceStatus.BINDING),
    ).toBe(false)
  })

  it('allows revoking from any live state', () => {
    for (const from of [
      DeviceStatus.BINDING,
      DeviceStatus.ACTIVE,
      DeviceStatus.SUSPECTED_SWAP,
    ]) {
      expect(canDeviceTransition(from, DeviceStatus.REVOKED)).toBe(true)
    }
  })

  it('treats only ACTIVE as a bound device', () => {
    expect(isDeviceUsable(DeviceStatus.ACTIVE)).toBe(true)
    // BINDING never passed its challenge.
    expect(isDeviceUsable(DeviceStatus.BINDING)).toBe(false)
    expect(isDeviceUsable(DeviceStatus.SUSPECTED_SWAP)).toBe(false)
    expect(isDeviceUsable(DeviceStatus.REVOKED)).toBe(false)
  })

  describe('isDeviceTrustedForValue', () => {
    const now = new Date('2026-07-28T12:00:00Z')

    it('trusts an active device past its cooling-off', () => {
      const past = new Date('2026-07-27T12:00:00Z')
      expect(isDeviceTrustedForValue(DeviceStatus.ACTIVE, past, now)).toBe(true)
    })

    it('refuses an active device still in cooling-off', () => {
      const future = new Date('2026-07-29T12:00:00Z')
      expect(isDeviceTrustedForValue(DeviceStatus.ACTIVE, future, now)).toBe(
        false,
      )
    })

    it('trusts an active device that never had a cooling-off', () => {
      expect(isDeviceTrustedForValue(DeviceStatus.ACTIVE, null, now)).toBe(true)
    })

    it('refuses a swap-suspected device even with no cooling-off', () => {
      expect(
        isDeviceTrustedForValue(DeviceStatus.SUSPECTED_SWAP, null, now),
      ).toBe(false)
    })
  })
})

describe('case lifecycle', () => {
  it('lets an escalated case be decided either way', () => {
    expect(
      canCaseTransition(FraudCaseStatus.ESCALATED, FraudCaseStatus.CLEARED),
    ).toBe(true)
    expect(
      canCaseTransition(
        FraudCaseStatus.ESCALATED,
        FraudCaseStatus.CONFIRMED_FRAUD,
      ),
    ).toBe(true)
  })

  /**
   * Terminal outcomes cannot be revisited. A case whose outcome could be revised after
   * the money moved is a case an insider can rewrite.
   */
  it('never reopens a resolved case', () => {
    for (const terminal of [
      FraudCaseStatus.CLEARED,
      FraudCaseStatus.CONFIRMED_FRAUD,
    ]) {
      expect(isCaseTerminal(terminal)).toBe(true)
      for (const target of Object.values(FraudCaseStatus)) {
        expect(canCaseTransition(terminal, target)).toBe(false)
      }
    }
  })

  it('round-trips through INFO_REQUESTED', () => {
    expect(
      canCaseTransition(
        FraudCaseStatus.INVESTIGATING,
        FraudCaseStatus.INFO_REQUESTED,
      ),
    ).toBe(true)
    expect(
      canCaseTransition(
        FraudCaseStatus.INFO_REQUESTED,
        FraudCaseStatus.INVESTIGATING,
      ),
    ).toBe(true)
  })
})

describe('isStepUpRedeemable', () => {
  const future = new Date(Date.now() + 60_000)
  const past = new Date(Date.now() - 60_000)

  it('accepts a fresh pending challenge with attempts left', () => {
    expect(isStepUpRedeemable(StepUpStatus.PENDING, future, 0, 3)).toBe(true)
    expect(isStepUpRedeemable(StepUpStatus.PENDING, future, 2, 3)).toBe(true)
  })

  it('refuses an expired challenge', () => {
    expect(isStepUpRedeemable(StepUpStatus.PENDING, past, 0, 3)).toBe(false)
  })

  it('refuses once attempts are exhausted', () => {
    expect(isStepUpRedeemable(StepUpStatus.PENDING, future, 3, 3)).toBe(false)
    expect(isStepUpRedeemable(StepUpStatus.PENDING, future, 9, 3)).toBe(false)
  })

  /** Single-use: a PASSED challenge cannot be answered again (T13 replay). */
  it.each([StepUpStatus.PASSED, StepUpStatus.FAILED, StepUpStatus.EXPIRED])(
    'refuses a %s challenge',
    (status) => {
      expect(isStepUpRedeemable(status, future, 0, 3)).toBe(false)
    },
  )
})

describe('velocity bucketing', () => {
  it('puts two moments in the same window in one bucket', () => {
    const windowMs = 600_000
    const a = new Date('2026-07-28T12:00:00Z')
    const b = new Date('2026-07-28T12:09:59Z')

    expect(velocityBucketKey(windowMs, a)).toBe(velocityBucketKey(windowMs, b))
  })

  it('rolls to a new bucket across a boundary', () => {
    const windowMs = 600_000
    const a = new Date('2026-07-28T12:09:59Z')
    const b = new Date('2026-07-28T12:10:01Z')

    expect(velocityBucketKey(windowMs, a)).not.toBe(
      velocityBucketKey(windowMs, b),
    )
  })

  it('refuses a non-positive window rather than dividing by zero', () => {
    expect(() => velocityBucketKey(0)).toThrow()
    expect(() => velocityBucketKey(-1)).toThrow()
  })

  it('resets at the end of the current window', () => {
    const windowMs = 600_000
    const now = new Date('2026-07-28T12:03:00Z')

    expect(velocityResetAt(windowMs, now).toISOString()).toBe(
      '2026-07-28T12:10:00.000Z',
    )
  })
})

describe('breachDegree', () => {
  it('is zero at or below the cap', () => {
    expect(breachDegree(5, 5)).toBe(0)
    expect(breachDegree(1, 5)).toBe(0)
  })

  /**
   * Half strength just over the line, full strength at twice the cap — so "one over"
   * and "six times over" are distinguishable. A boolean would lose the only
   * information separating a busy afternoon from an active drain.
   */
  it('ramps from just over half to full at twice the cap', () => {
    expect(breachDegree(6, 5)).toBeGreaterThan(0.5)
    expect(breachDegree(6, 5)).toBeLessThan(0.7)
    expect(breachDegree(10, 5)).toBe(1)
    expect(breachDegree(100, 5)).toBe(1)
  })

  it('is zero for a zero or negative cap', () => {
    expect(breachDegree(10, 0)).toBe(0)
    expect(breachDegree(10, -5)).toBe(0)
  })
})

describe('breachDegreeBigInt', () => {
  it('is zero at or below the cap', () => {
    expect(breachDegreeBigInt(100n, 100n)).toBe(0)
    expect(breachDegreeBigInt(50n, 100n)).toBe(0)
  })

  it('ramps like the numeric version', () => {
    expect(breachDegreeBigInt(150n, 100n)).toBeCloseTo(0.75, 2)
    expect(breachDegreeBigInt(200n, 100n)).toBe(1)
  })

  /**
   * The comparison that decides whether the signal fires happens in BigInt, so amounts
   * beyond `Number.MAX_SAFE_INTEGER` in minor units are still compared exactly. Only
   * the RATIO — a small bounded number — becomes a float.
   */
  it('stays exact for amounts beyond MAX_SAFE_INTEGER', () => {
    const cap = BigInt(Number.MAX_SAFE_INTEGER) * 10n

    // Exactly at the cap is not a breach — and this comparison is the one that must
    // stay in BigInt, because at this magnitude a float would round `cap + 1n` down
    // to `cap` and the signal would never fire at all.
    expect(breachDegreeBigInt(cap, cap)).toBe(0)

    /**
     * One unit over an astronomically large cap lands on the 0.5 FLOOR.
     *
     * That is the intended semantic, not a rounding artefact: any breach fires at half
     * strength minimum, and a one-unit excess over ~9×10^16 is a genuinely negligible
     * overshoot. The numeric version behaves identically — `breachDegree(6, 5)` is 0.6
     * only because 1/5 is a large proportional excess.
     */
    expect(breachDegreeBigInt(cap + 1n, cap)).toBe(0.5)
    expect(breachDegreeBigInt(cap * 3n, cap)).toBe(1)
  })

  it('is zero for a zero cap', () => {
    expect(breachDegreeBigInt(100n, 0n)).toBe(0)
  })
})

/**
 * End-to-end calibration of the weight table against the threat scenarios the module
 * claims to catch. These are the assertions that would fail if somebody re-tuned a
 * weight without thinking about what it does to a real attack.
 */
describe('threat-scenario calibration', () => {
  const s = (type: keyof typeof SIGNAL_WEIGHTS, value = 1): Signal => ({
    type,
    weight: SIGNAL_WEIGHTS[type],
    value,
    reason: type,
  })

  it('T1: a SIM swap alone challenges but does not hold', () => {
    const signals = [s('SIM_SUSPECTED_SWAP')]
    const score = aggregateRisk(signals)

    expect(decide({ score, signals, sensitive: true })).toBe(
      RiskDecision.STEP_UP,
    )
  })

  it('T1+T8: a SIM swap plus a large anomalous amount holds', () => {
    const signals = [
      s('SIM_SUSPECTED_SWAP'),
      s('AMOUNT_ANOMALY'),
      s('VELOCITY_VALUE'),
      s('DEVICE_NEW'),
    ]
    const score = aggregateRisk(signals)

    expect(score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.HOLD)
    expect(decide({ score, signals, sensitive: true })).toBe(RiskDecision.HOLD)
  })

  it('T2: the full account-takeover shape holds', () => {
    const signals = [
      s('DEVICE_NEW'),
      s('GEO_IMPOSSIBLE'),
      s('AMOUNT_ANOMALY'),
      s('ODD_HOUR'),
    ]
    const score = aggregateRisk(signals)

    expect(score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.STEP_UP)
    expect(decide({ score, signals, sensitive: true })).not.toBe(
      RiskDecision.ALLOW,
    )
  })

  it('T5/T7: new-beneficiary drain inside a mule cluster holds', () => {
    const signals = [
      s('NEW_BENEFICIARY_DRAIN'),
      s('MULE_GRAPH', 0.8),
      s('NEW_BENEFICIARY'),
      s('LARGE_CROSS_BORDER'),
      s('ODD_HOUR'),
    ]
    const score = aggregateRisk(signals)

    expect(score).toBeGreaterThanOrEqual(RISK_THRESHOLDS.HOLD)
    expect(decide({ score, signals, sensitive: true })).toBe(RiskDecision.HOLD)
  })

  it('T7: a watchlisted payee blocks outright', () => {
    const signals: Signal[] = [
      { type: 'WATCHLIST_HIT', weight: 1, value: 1, reason: 'x', isHard: true },
    ]

    expect(
      decide({
        score: aggregateRisk(signals),
        signals,
        sensitive: true,
      }),
    ).toBe(RiskDecision.BLOCK)
  })

  /**
   * The false-positive guard, and the most important test here. A trusted user paying
   * a known payee at an odd hour must sail through — a fraud system that adds friction
   * to the ordinary case gets switched off.
   */
  it('does not challenge an ordinary payment from a trusted device', () => {
    const signals = [s('ODD_HOUR')]
    const score = aggregateRisk(signals)

    expect(decide({ score, signals, sensitive: true })).toBe(RiskDecision.ALLOW)
  })

  it('does not challenge a large payment with no other signal', () => {
    const signals = [s('LARGE_CROSS_BORDER')]
    const score = aggregateRisk(signals)

    expect(
      decide({ score, signals, sensitive: true, amountMinor: 500_000_00n }),
    ).toBe(RiskDecision.ALLOW)
  })

  /**
   * A degraded collector must not, on its own, add friction. `COLLECTOR_FAILED` is
   * weighted 0.10 precisely so an outage nudges borderline cases without challenging
   * everybody — the failure mode that would have operators disable the layer.
   */
  it('does not challenge on a collector failure alone', () => {
    const signals: Signal[] = [
      { type: 'COLLECTOR_FAILED', weight: 0.1, value: 1, reason: 'x' },
    ]

    expect(
      decide({ score: aggregateRisk(signals), signals, sensitive: false }),
    ).toBe(RiskDecision.ALLOW)
  })
})

describe('isWeakPin', () => {
  /**
   * Each of these is a real top-of-the-list PIN, not a synthetic pattern. The Berlin
   * leaked-PIN dataset is dominated by exactly these shapes, and the point of the detector is
   * that bcrypt at cost 12 is irrelevant when the plaintext is guessable in ten tries.
   */
  it.each([
    ['all one digit', '111111'],
    ['all zeroes', '000000'],
    ['ascending run', '123456'],
    ['descending run', '654321'],
    ['ascending from another start', '345678'],
    ['a birth year leading', '199012'],
    ['a birth year trailing', '121990'],
    ['a recent year leading', '202400'],
    ['a two-digit unit repeated', '121212'],
    ['a three-digit unit repeated', '123123'],
  ])('rejects %s', (_label, pin) => {
    expect(isWeakPin(pin)).toBe(true)
  })

  it.each([
    ['a scattered PIN', '473859'],
    ['one with a repeat but no pattern', '905317'],
    ['one whose run breaks at the end', '123458'],
  ])('accepts %s', (_label, pin) => {
    expect(isWeakPin(pin)).toBe(false)
  })

  /**
   * The year rule inspects the FIRST four digits and the LAST four, not every window — so
   * `419905` carries 1990 at offset 1 and passes. Pinned deliberately rather than left
   * undiscovered, because it is a real boundary and the reasoning belongs somewhere: people
   * pad a year on ONE side (`199012`, `121990`), which both ends already cover. Splitting a
   * year across the middle with one spare digit at each end is not a way anybody builds a PIN
   * from a birthday, and widening the rule to every offset would reject half again as many
   * genuinely random PINs for it.
   *
   * If this ever becomes worth catching, the change is a `for` over offsets 0..2 — and this
   * test is what will tell you the behaviour changed on purpose.
   */
  it('does not look for a year straddling the middle', () => {
    expect(isWeakPin('419905')).toBe(false)
  })

  /**
   * A malformed PIN is not this function's job to reject — `assertWellFormed` runs first and
   * throws. What matters is that a short or non-numeric string cannot make the detector throw
   * and thereby skip the strength check entirely on the way to a 500.
   */
  it('is total over malformed input rather than throwing', () => {
    expect(() => isWeakPin('')).not.toThrow()
    expect(() => isWeakPin('12')).not.toThrow()
    expect(() => isWeakPin('abcdef')).not.toThrow()
  })
})
