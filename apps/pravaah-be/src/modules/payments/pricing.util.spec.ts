import { RATE_SCALE, rateE8FromString } from '@/modules/payments/money.util'
import { FEE_POLICY, GST_BPS } from '@/modules/payments/payments.config'
import { feeFor, priceTransfer, taxFor } from '@/modules/payments/pricing.util'

import { Corridor } from 'generated/prisma/client'

const SGD_INR = rateE8FromString('65.40')

describe('pricing.util — fees', () => {
  it('charges nothing on domestic UPI', () => {
    // Not generosity: NPCI prohibits a merchant discount rate on UPI P2P and P2M,
    // so a fee here would not be a pricing decision, it would be non-compliance.
    expect(feeFor(Corridor.DOMESTIC, 10_000_000n)).toBe(0n)
    expect(feeFor(Corridor.DOMESTIC, 1n)).toBe(0n)
  })

  it('charges 0.5% cross-border', () => {
    // S$100.00 → 50 cents
    expect(feeFor(Corridor.CROSS_BORDER, 10_000n)).toBe(50n)
    // S$1,000.00 → S$5.00
    expect(feeFor(Corridor.CROSS_BORDER, 100_000n)).toBe(500n)
  })

  it('applies the floor to a tiny cross-border transfer', () => {
    // 0.5% of S$2.00 is one cent, which does not cover the rail's own per-message
    // cost.
    expect(feeFor(Corridor.CROSS_BORDER, 200n)).toBe(
      FEE_POLICY.CROSS_BORDER.minMinor,
    )
  })

  it('applies the ceiling to a large one', () => {
    expect(feeFor(Corridor.CROSS_BORDER, 100_000_000n)).toBe(
      FEE_POLICY.CROSS_BORDER.maxMinor,
    )
  })

  it('charges GST only on an INR-denominated fee', () => {
    // Indian GST is a tax on a supply made in India. Charging it on an
    // SGD-denominated fee to a Singapore-resident sender would invent a liability.
    expect(taxFor(100n, 'INR')).toBe((100n * BigInt(GST_BPS)) / 10_000n)
    expect(taxFor(100n, 'SGD')).toBe(0n)
    expect(taxFor(0n, 'INR')).toBe(0n)
  })
})

describe('pricing.util — priceTransfer', () => {
  it('prices a cross-border send from the source side', () => {
    const priced = priceTransfer({
      mode: 'SOURCE',
      amountMinor: 10_000n, // S$100.00
      sourceCurrency: 'SGD',
      destCurrency: 'INR',
      midRateE8: SGD_INR,
    })

    expect(priced.corridor).toBe(Corridor.CROSS_BORDER)
    expect(priced.spreadBps).toBe(50)
    // 65.40 less 50bps = 65.073 → ₹6,507.30
    expect(priced.rateE8).toBe(rateE8FromString('65.073'))
    expect(priced.sourceAmount).toBe(10_000n)
    expect(priced.destAmount).toBe(650_730n)
    expect(priced.feeMinor).toBe(50n)
    // Fee is in SGD, so no Indian GST.
    expect(priced.taxMinor).toBe(0n)
    expect(priced.totalDebitMinor).toBe(10_050n)
  })

  it('prices the same transfer from the destination side', () => {
    // "They must receive ₹6,50,730" — the reverse of the case above, and it must
    // land back on the same source amount.
    const priced = priceTransfer({
      mode: 'DEST',
      amountMinor: 650_730n,
      sourceCurrency: 'SGD',
      destCurrency: 'INR',
      midRateE8: SGD_INR,
    })
    expect(priced.sourceAmount).toBe(10_000n)
    expect(priced.destAmount).toBe(650_730n)
  })

  it('never delivers short of a destination-side target', () => {
    // The two modes round in opposite directions on purpose. A DEST quote that
    // rounded the sender's cost down would deliver one paisa less than the figure
    // the user named, and "one paisa short" on a school fee is a rejected payment.
    for (const target of [1n, 7n, 99n, 6_541n, 123_457n]) {
      const priced = priceTransfer({
        mode: 'DEST',
        amountMinor: target,
        sourceCurrency: 'SGD',
        destCurrency: 'INR',
        midRateE8: SGD_INR,
      })
      const delivered = priceTransfer({
        mode: 'SOURCE',
        amountMinor: priced.sourceAmount,
        sourceCurrency: 'SGD',
        destCurrency: 'INR',
        midRateE8: SGD_INR,
      }).destAmount
      expect(delivered).toBeGreaterThanOrEqual(target)
    }
  })

  it('prices a domestic transfer at 1:1 with no fee', () => {
    const priced = priceTransfer({
      mode: 'SOURCE',
      amountMinor: 500_000n,
      sourceCurrency: 'INR',
      destCurrency: 'INR',
      midRateE8: RATE_SCALE,
    })
    expect(priced.corridor).toBe(Corridor.DOMESTIC)
    expect(priced.rateE8).toBe(RATE_SCALE)
    expect(priced.spreadBps).toBe(0)
    expect(priced.sourceAmount).toBe(500_000n)
    expect(priced.destAmount).toBe(500_000n)
    expect(priced.feeMinor).toBe(0n)
    expect(priced.taxMinor).toBe(0n)
    expect(priced.totalDebitMinor).toBe(500_000n)
  })

  it('refuses to re-rate a same-currency transfer', () => {
    // A bad rate row (a feed returning `INR_INR: 1.02`) would otherwise silently
    // convert rupees into fewer rupees. The ledger would balance perfectly while
    // the beneficiary was short.
    expect(() =>
      priceTransfer({
        mode: 'SOURCE',
        amountMinor: 500_000n,
        sourceCurrency: 'INR',
        destCurrency: 'INR',
        midRateE8: rateE8FromString('1.02'),
      }),
    ).toThrow(/1:1/)
  })

  it('refuses an amount too small to convert to anything', () => {
    // A transfer that debits the sender and credits the beneficiary nothing is
    // arithmetically balanced and completely wrong.
    expect(() =>
      priceTransfer({
        mode: 'SOURCE',
        amountMinor: 1n, // 1 paisa → 0.0001 cents
        sourceCurrency: 'INR',
        destCurrency: 'SGD',
        midRateE8: rateE8FromString('0.01529052'),
      }),
    ).toThrow(/too small/)
  })

  it('refuses a non-positive amount', () => {
    expect(() =>
      priceTransfer({
        mode: 'SOURCE',
        amountMinor: 0n,
        sourceCurrency: 'INR',
        destCurrency: 'INR',
        midRateE8: RATE_SCALE,
      }),
    ).toThrow(/positive/)
  })

  it('keeps the total exactly equal to source + fee + tax', () => {
    // The invariant the RESERVE posting depends on. If these ever disagree, the
    // ledger reserve and the transaction row describe different amounts of money.
    for (const amount of [200n, 1_000n, 10_000n, 999_999n]) {
      const priced = priceTransfer({
        mode: 'SOURCE',
        amountMinor: amount,
        sourceCurrency: 'SGD',
        destCurrency: 'INR',
        midRateE8: SGD_INR,
      })
      expect(priced.totalDebitMinor).toBe(
        priced.sourceAmount + priced.feeMinor + priced.taxMinor,
      )
    }
  })
})
