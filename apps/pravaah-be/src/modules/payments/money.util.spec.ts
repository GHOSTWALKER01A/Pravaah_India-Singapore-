import {
  RATE_SCALE,
  applyBps,
  applySpread,
  convertMinor,
  divRound,
  formatMoney,
  fromMinor,
  invertMinor,
  majorToMinor,
  mulDivRound,
  rateE8FromString,
  rateE8ToString,
  subMinor,
  sumMinor,
  toMinor,
} from '@/modules/payments/money.util'

describe('money.util', () => {
  describe('divRound', () => {
    it('returns the exact quotient when there is no remainder', () => {
      expect(divRound(100n, 4n, 'DOWN')).toBe(25n)
      expect(divRound(100n, 4n, 'UP')).toBe(25n)
      expect(divRound(100n, 4n, 'HALF_UP')).toBe(25n)
      expect(divRound(100n, 4n, 'HALF_EVEN')).toBe(25n)
    })

    it('truncates on DOWN and always climbs on UP', () => {
      expect(divRound(7n, 2n, 'DOWN')).toBe(3n)
      expect(divRound(7n, 2n, 'UP')).toBe(4n)
      // A single unit of remainder is still a remainder.
      expect(divRound(101n, 100n, 'DOWN')).toBe(1n)
      expect(divRound(101n, 100n, 'UP')).toBe(2n)
    })

    it('breaks an exact tie upward on HALF_UP', () => {
      expect(divRound(5n, 2n, 'HALF_UP')).toBe(3n)
      expect(divRound(15n, 10n, 'HALF_UP')).toBe(2n)
      // Just below the tie stays down.
      expect(divRound(14n, 10n, 'HALF_UP')).toBe(1n)
    })

    it('breaks an exact tie to the even neighbour on HALF_EVEN', () => {
      // 2.5 → 2 (even), 3.5 → 4 (even). This is the property that makes the
      // rounding bias cancel over many operations instead of accumulating.
      expect(divRound(5n, 2n, 'HALF_EVEN')).toBe(2n)
      expect(divRound(7n, 2n, 'HALF_EVEN')).toBe(4n)
      // Non-ties are unaffected.
      expect(divRound(11n, 4n, 'HALF_EVEN')).toBe(3n)
    })

    it('refuses a negative amount rather than defining a rounding for it', () => {
      // Direction lives in LedgerDirection, never in the sign of an amount, so a
      // negative here means a caller has confused an amount with a delta.
      expect(() => divRound(-5n, 2n, 'DOWN')).toThrow(/negative/)
    })

    it('refuses a non-positive denominator', () => {
      expect(() => divRound(5n, 0n, 'DOWN')).toThrow(/positive/)
      expect(() => divRound(5n, -2n, 'DOWN')).toThrow(/positive/)
    })
  })

  describe('mulDivRound', () => {
    it('multiplies before dividing so no precision is lost in between', () => {
      // Dividing first would give 1 * 3 = 3; the correct answer keeps the
      // remainder available to the multiplication.
      expect(mulDivRound(100n, 3n, 70n, 'DOWN')).toBe(4n)
    })

    it('stays exact well past the safe-integer range', () => {
      const huge = 9_007_199_254_740_993n // 2^53 + 1, unrepresentable as a double
      expect(mulDivRound(huge, 2n, 1n, 'DOWN')).toBe(18_014_398_509_481_986n)
    })
  })

  describe('applyBps', () => {
    it('computes a basis-point share', () => {
      // 0.5% of 100.00 = 0.50
      expect(applyBps(10_000n, 50)).toBe(50n)
      // 18% GST on a 50-cent fee = 9 cents
      expect(applyBps(50n, 1_800)).toBe(9n)
    })

    it('short-circuits zero bps to zero', () => {
      expect(applyBps(123_456n, 0)).toBe(0n)
    })

    it('rejects a negative or fractional bps', () => {
      expect(() => applyBps(100n, -1)).toThrow()
      expect(() => applyBps(100n, 1.5)).toThrow()
    })
  })

  describe('toMinor', () => {
    it('accepts a canonical digit string', () => {
      expect(toMinor('0')).toBe(0n)
      expect(toMinor('150000')).toBe(150_000n)
    })

    it('accepts a bigint and a safe integer unchanged', () => {
      expect(toMinor(42n)).toBe(42n)
      expect(toMinor(42)).toBe(42n)
    })

    it('rejects a decimal rather than guessing which unit it is', () => {
      // "15.5" in a minor-unit field is a major-unit amount that has arrived in
      // the wrong place. 15 paise, 1550 paise and 16 paise are all defensible
      // guesses, which is exactly why none of them is made.
      expect(() => toMinor('15.5')).toThrow()
      expect(() => toMinor(15.5)).toThrow()
    })

    it('rejects exponent notation, leading zeros and negatives', () => {
      expect(() => toMinor('1e5')).toThrow()
      expect(() => toMinor('0100')).toThrow()
      expect(() => toMinor('-5')).toThrow()
      expect(() => toMinor(-5)).toThrow()
    })
  })

  describe('majorToMinor', () => {
    it('scales by the currency exponent', () => {
      expect(majorToMinor('100.50', 'INR')).toBe(10_050n)
      expect(majorToMinor('100', 'INR')).toBe(10_000n)
      expect(majorToMinor('0.01', 'SGD')).toBe(1n)
    })

    it('is exact where the float path is not', () => {
      // This is the whole reason the parse is string surgery. `4.35 * 100` is
      // 434.99999999999994 in IEEE-754, so the obvious implementation loses a
      // paisa on an amount a user can trivially type — and loses it silently.
      expect(Math.floor(Number.parseFloat('4.35') * 100)).toBe(434)
      expect(majorToMinor('4.35', 'INR')).toBe(435n)

      expect(majorToMinor('8.11', 'INR')).toBe(811n)
      expect(majorToMinor('1.10', 'INR')).toBe(110n)
    })

    it('rejects more decimal places than the currency has', () => {
      // A QR claiming `am=100.999` for rupees is malformed or crafted; rounding
      // it would resolve an ambiguity about somebody's money by guessing.
      expect(() => majorToMinor('100.999', 'INR')).toThrow(/decimal places/)
    })
  })

  describe('fromMinor / formatMoney', () => {
    it('always renders the full number of decimal places', () => {
      expect(fromMinor(10_050n, 'INR')).toBe('100.50')
      expect(fromMinor(5n, 'INR')).toBe('0.05')
      expect(fromMinor(0n, 'INR')).toBe('0.00')
    })

    it('groups INR as 2,2,3 from the right', () => {
      // ₹12,34,567.89 — not ₹1,234,567.89. An Indian user reading a
      // Western-grouped figure has to count digits to tell a lakh from a million,
      // on the screen where they confirm how much of their money leaves.
      expect(formatMoney(123_456_789n, 'INR')).toBe('₹12,34,567.89')
      expect(formatMoney(100_000n, 'INR')).toBe('₹1,000.00')
      expect(formatMoney(10_000_000n, 'INR')).toBe('₹1,00,000.00')
    })

    it('groups SGD in threes', () => {
      expect(formatMoney(123_456_789n, 'SGD')).toBe('S$1,234,567.89')
      expect(formatMoney(100_000n, 'SGD')).toBe('S$1,000.00')
    })

    it('round-trips through majorToMinor', () => {
      for (const minor of [0n, 1n, 99n, 100n, 123_456_789n]) {
        expect(majorToMinor(fromMinor(minor, 'INR'), 'INR')).toBe(minor)
      }
    })
  })

  describe('rate parsing', () => {
    it('parses a decimal rate by string surgery, not parseFloat', () => {
      expect(rateE8FromString('1')).toBe(RATE_SCALE)
      expect(rateE8FromString('65.40')).toBe(6_540_000_000n)
      expect(rateE8FromString('0.01529052')).toBe(1_529_052n)
    })

    it('round-trips a rate', () => {
      for (const rate of ['1', '65.4', '0.01529052', '12345.6789']) {
        expect(rateE8ToString(rateE8FromString(rate))).toBe(rate)
      }
    })

    it('rejects more precision than the scale can hold', () => {
      expect(() => rateE8FromString('1.123456789')).toThrow()
    })
  })

  describe('applySpread', () => {
    it('always moves the customer rate against the customer', () => {
      // 65.40 less 50bps = 65.073
      expect(rateE8ToString(applySpread(rateE8FromString('65.40'), 50))).toBe(
        '65.073',
      )
    })

    it('is a no-op at zero spread', () => {
      const mid = rateE8FromString('65.40')
      expect(applySpread(mid, 0)).toBe(mid)
    })

    it('rejects an implausible spread', () => {
      expect(() => applySpread(RATE_SCALE, 10_000)).toThrow()
      expect(() => applySpread(RATE_SCALE, -1)).toThrow()
    })
  })

  describe('convertMinor', () => {
    it('converts at the locked rate', () => {
      // S$50.00 at 65.40 → ₹3,270.00
      expect(
        convertMinor({
          amountMinor: 5_000n,
          rateE8: rateE8FromString('65.40'),
          sourceCurrency: 'SGD',
          destCurrency: 'INR',
        }),
      ).toBe(327_000n)
    })

    it('rounds DOWN by default so the platform never invents money', () => {
      // 1 cent at 65.40 = 65.4 paise. Rounding up would credit a paisa the FX
      // position has to fund out of nothing.
      expect(
        convertMinor({
          amountMinor: 1n,
          rateE8: rateE8FromString('65.40'),
          sourceCurrency: 'SGD',
          destCurrency: 'INR',
        }),
      ).toBe(65n)
    })

    it('rejects a non-positive rate', () => {
      expect(() =>
        convertMinor({
          amountMinor: 100n,
          rateE8: 0n,
          sourceCurrency: 'SGD',
          destCurrency: 'INR',
        }),
      ).toThrow(/positive/)
    })
  })

  describe('invertMinor', () => {
    it('rounds UP so the recipient is never short of the figure they were promised', () => {
      // "They must receive ₹65.41" — 65.41 paise ÷ 65.40 is not a whole cent, and
      // rounding the sender's cost down would deliver less than the named amount.
      const source = invertMinor({
        destAmountMinor: 6_541n,
        rateE8: rateE8FromString('65.40'),
        sourceCurrency: 'SGD',
        destCurrency: 'INR',
      })
      const delivered = convertMinor({
        amountMinor: source,
        rateE8: rateE8FromString('65.40'),
        sourceCurrency: 'SGD',
        destCurrency: 'INR',
      })
      expect(delivered).toBeGreaterThanOrEqual(6_541n)
    })

    it('inverts exactly when the division is clean', () => {
      expect(
        invertMinor({
          destAmountMinor: 327_000n,
          rateE8: rateE8FromString('65.40'),
          sourceCurrency: 'SGD',
          destCurrency: 'INR',
        }),
      ).toBe(5_000n)
    })
  })

  describe('sumMinor / subMinor', () => {
    it('sums non-negative amounts', () => {
      expect(sumMinor(100n, 50n, 9n)).toBe(159n)
      expect(sumMinor()).toBe(0n)
    })

    it('rejects a negative contribution', () => {
      expect(() => sumMinor(100n, -1n)).toThrow()
    })

    it('throws rather than clamping when a subtraction would go negative', () => {
      // A negative here means an invariant already broke — refunding more than was
      // settled, releasing more limit than was consumed. Clamping to zero would
      // let the caller continue with a plausible number and hide the breach.
      expect(() => subMinor(100n, 101n, 'refund')).toThrow(/would go negative/)
      expect(subMinor(100n, 100n, 'refund')).toBe(0n)
    })
  })
})
