import {
  buildUpiIntent,
  parseUpiIntent,
  signQr,
  verifyQrSignature,
} from '@/modules/payments/upi-qr.util'

describe('upi-qr.util — build', () => {
  it('encodes a static (amount-less) intent', () => {
    const payload = buildUpiIntent({
      payeeAddress: 'ravi@pravaah',
      payeeName: 'Ravi Kumar',
      currency: 'INR',
    })
    expect(payload).toBe('upi://pay?pa=ravi%40pravaah&pn=Ravi%20Kumar&cu=INR')
  })

  it('renders the amount in major units, derived from the minor-unit integer', () => {
    const payload = buildUpiIntent({
      payeeAddress: 'shop@pravaah',
      payeeName: 'Chai Stall',
      amountMinor: 12_050n,
      currency: 'INR',
      merchantCode: '5812',
    })
    // The specification says major units with the currency's full precision, and
    // that conversion happens exactly once, here.
    expect(payload).toContain('am=120.50')
    expect(payload).toContain('mc=5812')
  })

  it('rejects an invalid payee address', () => {
    expect(() =>
      buildUpiIntent({ payeeAddress: 'not-a-vpa', currency: 'INR' }),
    ).toThrow()
  })

  it('rejects a zero amount when one is present at all', () => {
    expect(() =>
      buildUpiIntent({
        payeeAddress: 'ravi@pravaah',
        amountMinor: 0n,
        currency: 'INR',
      }),
    ).toThrow(/positive/)
  })
})

describe('upi-qr.util — parse', () => {
  it('round-trips what it builds', () => {
    const payload = buildUpiIntent({
      payeeAddress: 'shop@pravaah',
      payeeName: 'Chai Stall',
      amountMinor: 12_050n,
      currency: 'INR',
      note: 'Order 42',
      txnRef: 'REF123',
    })
    const result = parseUpiIntent(payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.intent).toMatchObject({
      payeeAddress: 'shop@pravaah',
      payeeName: 'Chai Stall',
      amountMinor: 12_050n,
      currency: 'INR',
      note: 'Order 42',
      txnRef: 'REF123',
    })
  })

  it('REJECTS a duplicated parameter rather than guessing which payee is real', () => {
    // `pa=shop@psp&pa=attacker@psp` is a real attack, and it works because
    // implementations disagree about which value wins: URLSearchParams.get returns
    // the first, some parsers keep the last, and a preview screen rendering one
    // while the payment uses the other shows the payer a payee they are not paying.
    const result = parseUpiIntent(
      'upi://pay?pa=shop%40pravaah&pa=attacker%40evil&cu=INR',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/repeats/)
  })

  it('rejects a duplicated amount too', () => {
    const result = parseUpiIntent(
      'upi://pay?pa=shop%40pravaah&am=1.00&am=100.00&cu=INR',
    )
    expect(result.ok).toBe(false)
  })

  it('accepts an upper-case scheme, as seen in the wild', () => {
    expect(parseUpiIntent('UPI://PAY?pa=ravi%40pravaah').ok).toBe(true)
  })

  it('rejects anything that is not a UPI payment link', () => {
    for (const payload of [
      'https://evil.example/pay?pa=attacker@evil',
      'upi://collect?pa=ravi@pravaah',
      'pa=ravi@pravaah',
      '',
    ]) {
      expect(parseUpiIntent(payload).ok).toBe(false)
    }
  })

  it('rejects an over-long payload', () => {
    expect(
      parseUpiIntent(`upi://pay?pa=ravi%40pravaah&tn=${'x'.repeat(3000)}`).ok,
    ).toBe(false)
  })

  it('requires a payee address', () => {
    const result = parseUpiIntent('upi://pay?am=100.00&cu=INR')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/payee/)
  })

  it('rejects a malformed payee address', () => {
    expect(parseUpiIntent('upi://pay?pa=not-a-vpa').ok).toBe(false)
  })

  it('defaults the currency to INR and rejects an unsupported one', () => {
    const inr = parseUpiIntent('upi://pay?pa=ravi%40pravaah')
    expect(inr.ok && inr.intent.currency).toBe('INR')
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&cu=XXX').ok).toBe(false)
  })

  it('rejects an amount with more precision than the currency has', () => {
    // `am=100.999` for a rupee amount is malformed or crafted; rounding it would
    // resolve an ambiguity about somebody's money by guessing.
    expect(
      parseUpiIntent('upi://pay?pa=ravi%40pravaah&am=100.999&cu=INR').ok,
    ).toBe(false)
  })

  it('rejects a zero, negative or non-numeric amount', () => {
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&am=0.00').ok).toBe(false)
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&am=-5.00').ok).toBe(
      false,
    )
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&am=abc').ok).toBe(false)
  })

  it('rejects a malformed merchant category code', () => {
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&mc=58').ok).toBe(false)
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&mc=5812').ok).toBe(true)
  })

  it('rejects a parameter with no value', () => {
    expect(parseUpiIntent('upi://pay?pa=ravi%40pravaah&am').ok).toBe(false)
    expect(parseUpiIntent('upi://pay?=value').ok).toBe(false)
  })

  it('rejects broken percent-encoding rather than throwing', () => {
    const result = parseUpiIntent('upi://pay?pa=ravi%ZZpravaah')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/encoding/)
  })

  it('decodes a plus as a space in the note', () => {
    const result = parseUpiIntent('upi://pay?pa=ravi%40pravaah&tn=Chai+Order')
    expect(result.ok && result.intent.note).toBe('Chai Order')
  })
})

describe('upi-qr.util — dynamic QR signatures', () => {
  const secret = 'test-secret-key'
  const fields = {
    ref: 'qr_abc123',
    payeeAddress: 'shop@pravaah',
    amountMinor: 12_050n,
    currency: 'INR',
    expiresAt: new Date('2026-07-27T10:15:00Z'),
  }

  it('verifies its own signature', () => {
    expect(verifyQrSignature(secret, fields, signQr(secret, fields))).toBe(true)
  })

  it('detects a tampered amount', () => {
    // The attack this exists to stop: change `am=1.00` to `am=100.00` in a
    // forwarded image, with the merchant's real VPA beside it to make it
    // convincing.
    const signature = signQr(secret, fields)
    expect(
      verifyQrSignature(
        secret,
        { ...fields, amountMinor: 1_205_000n },
        signature,
      ),
    ).toBe(false)
  })

  it('detects a tampered payee, reference, currency or expiry', () => {
    const signature = signQr(secret, fields)
    expect(
      verifyQrSignature(
        secret,
        { ...fields, payeeAddress: 'evil@pravaah' },
        signature,
      ),
    ).toBe(false)
    expect(
      verifyQrSignature(secret, { ...fields, ref: 'qr_other' }, signature),
    ).toBe(false)
    expect(
      verifyQrSignature(secret, { ...fields, currency: 'SGD' }, signature),
    ).toBe(false)
    expect(
      verifyQrSignature(
        secret,
        { ...fields, expiresAt: new Date('2027-07-27T10:15:00Z') },
        signature,
      ),
    ).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    expect(
      verifyQrSignature(secret, fields, signQr('other-secret', fields)),
    ).toBe(false)
  })

  it('cannot be fooled by shifting a boundary between fields', () => {
    // Length-prefixed, not separator-joined. With a plain separator, a value
    // containing it could shift the boundary and produce a different intent with
    // an identical signing payload.
    const a = signQr(secret, {
      ...fields,
      ref: 'ab',
      payeeAddress: 'c@pravaah',
    })
    const b = signQr(secret, {
      ...fields,
      ref: 'a',
      payeeAddress: 'bc@pravaah',
    })
    expect(a).not.toBe(b)
  })

  it('returns false rather than throwing on a length mismatch', () => {
    expect(verifyQrSignature(secret, fields, 'short')).toBe(false)
    expect(verifyQrSignature(secret, fields, '')).toBe(false)
  })
})
