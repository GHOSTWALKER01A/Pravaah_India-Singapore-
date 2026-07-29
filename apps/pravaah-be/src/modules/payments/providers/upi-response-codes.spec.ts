import {
  UPI_RESPONSE_CODES,
  classifyRailCode,
  isSuccessCode,
  releasesReserve,
} from '@/modules/payments/providers/upi-response-codes'

describe('upi-response-codes', () => {
  it('classifies a success', () => {
    expect(classifyRailCode('00').outcome).toBe('SUCCESS')
    expect(isSuccessCode('00')).toBe(true)
  })

  it('treats an UNKNOWN code as DEEMED, never as failed', () => {
    // The most important line in the module. Rails add codes and PSPs return
    // undocumented ones; a system that reads "I have never seen this" as "nothing
    // happened" will refund senders for payments that settled.
    const unknown = classifyRailCode('QQ')
    expect(unknown.outcome).toBe('DEEMED')
    expect(unknown.retryable).toBe(false)
    expect(releasesReserve('QQ')).toBe(false)
  })

  it('treats a MISSING code as DEEMED', () => {
    expect(classifyRailCode(null).outcome).toBe('DEEMED')
    expect(classifyRailCode(undefined).outcome).toBe('DEEMED')
    expect(classifyRailCode('').outcome).toBe('DEEMED')
  })

  it('never releases a reserve on a timeout code', () => {
    // Each of these means the rail did not tell us the outcome. Releasing the reserve
    // would refund a sender whose payment may be settling right now.
    for (const code of ['BT', 'U54', 'U67', 'U68', 'U88', '68', '21']) {
      expect(classifyRailCode(code).outcome).toBe('DEEMED')
      expect(releasesReserve(code)).toBe(false)
    }
  })

  it('releases the reserve on a definite refusal', () => {
    for (const code of ['ZA', 'ZM', 'Z9', 'ZH', 'XH', 'U16']) {
      expect(releasesReserve(code)).toBe(true)
    }
  })

  it('marks technical declines retryable and business declines not', () => {
    // A payer who declined, or typed a wrong PIN, must not have the payment silently
    // re-presented — that would be the worst possible reading of their intent.
    expect(classifyRailCode('ZA').retryable).toBe(false)
    expect(classifyRailCode('ZM').retryable).toBe(false)
    expect(classifyRailCode('Z9').retryable).toBe(false)
    expect(classifyRailCode('ZH').retryable).toBe(false)

    // A bank being briefly unavailable is worth another attempt.
    expect(classifyRailCode('U30').retryable).toBe(true)
    expect(classifyRailCode('U53').retryable).toBe(true)
    expect(classifyRailCode('91').retryable).toBe(true)
  })

  it('classifies a duplicate transmission as SUCCESS, not failure', () => {
    // `94` means the rail already holds a transaction with our reference. Treating it as
    // a failure would reverse a reserve for a payment the rail is holding.
    expect(classifyRailCode('94').outcome).toBe('SUCCESS')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(classifyRailCode(' za ').outcome).toBe('FAILED_TERMINAL')
    expect(classifyRailCode('u30').outcome).toBe('FAILED_RETRYABLE')
  })

  it('gives every code an actionable user message', () => {
    // "Transaction failed (U30)" tells a person nothing they can do. Every entry has to
    // say what to try, or it belongs in a log rather than on a screen.
    for (const [code, meaning] of Object.entries(UPI_RESPONSE_CODES)) {
      expect(meaning.userMessage.length).toBeGreaterThan(10)
      expect(meaning.userMessage).not.toContain(code)
      expect(meaning.detail.length).toBeGreaterThan(5)
    }
  })

  it('keeps `retryable` consistent with the outcome', () => {
    // The flag is derived, so it can never disagree with the classification — a code
    // marked terminal-but-retryable would have the saga re-presenting a refused payment.
    for (const meaning of Object.values(UPI_RESPONSE_CODES)) {
      expect(meaning.retryable).toBe(meaning.outcome === 'FAILED_RETRYABLE')
    }
  })

  it('covers the collect and mandate failure codes', () => {
    // The pull-flow cases: an expired collect, and every reason a mandate debit is refused.
    expect(classifyRailCode('U69').outcome).toBe('FAILED_TERMINAL')
    expect(classifyRailCode('M3').detail).toMatch(/exceeds the authorised/i)
    expect(classifyRailCode('M5').detail).toMatch(/notification/i)
  })
})
