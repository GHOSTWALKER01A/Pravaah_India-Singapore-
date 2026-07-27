/**
 * Dummy DEPOSIT (savings account) FI payload, shaped like a ReBIT AA
 * `DEPOSIT` FI schema. The real AA sandbox mandates dummy data, so this mirrors
 * sandbox behaviour rather than being a shortcut. ~12 months of transactions
 * with steady salary credits → clean income-regularity + coverage for M2.
 */
export const dummyDepositStatement = {
  Account: {
    type: 'deposit',
    maskedAccNumber: 'XXXXXX6789',
    fipId: 'FIP-HDFC',
    Summary: {
      currentBalance: '184230.55',
      currency: 'INR',
      branch: 'MG Road, Bengaluru',
      ifscCode: 'HDFC0000123',
      openingDate: '2019-06-14',
    },
    Transactions: {
      Transaction: buildTransactions(),
    },
  },
}

function buildTransactions(): Array<{
  type: 'CREDIT' | 'DEBIT'
  amount: string
  currentBalance: string
  transactionTimestamp: string
  narration: string
}> {
  const txns: ReturnType<typeof buildTransactions> = []
  let balance = 92000
  // 12 months, ending 2026-06. Salary credit + a couple of debits per month.
  const months = [
    '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
    '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
  ]
  const salary = 85000
  // One dishonoured auto-debit, deliberately kept in: it gives M2's "why this
  // score" panel a real NEGATIVE driver to explain instead of a flawless
  // profile with nothing to say.
  const bounceMonth = '2025-11'
  for (const m of months) {
    balance += salary
    txns.push({
      type: 'CREDIT',
      amount: salary.toFixed(2),
      currentBalance: balance.toFixed(2),
      transactionTimestamp: `${m}-01T09:30:00+05:30`,
      narration: 'SALARY CREDIT ACME TECHNOLOGIES',
    })
    const rent = 32000
    balance -= rent
    txns.push({
      type: 'DEBIT',
      amount: rent.toFixed(2),
      currentBalance: balance.toFixed(2),
      transactionTimestamp: `${m}-05T11:00:00+05:30`,
      narration: 'RENT NEFT',
    })
    if (m === bounceMonth) {
      const charge = 590
      balance -= charge
      txns.push({
        type: 'DEBIT',
        amount: charge.toFixed(2),
        currentBalance: balance.toFixed(2),
        transactionTimestamp: `${m}-12T07:15:00+05:30`,
        narration: 'ECS RTN CHG SIP MANDATE INSUFFICIENT BAL',
      })
    }
    const spend = 21000
    balance -= spend
    txns.push({
      type: 'DEBIT',
      amount: spend.toFixed(2),
      currentBalance: balance.toFixed(2),
      transactionTimestamp: `${m}-18T18:45:00+05:30`,
      narration: 'UPI SPENDS',
    })
  }
  return txns
}
