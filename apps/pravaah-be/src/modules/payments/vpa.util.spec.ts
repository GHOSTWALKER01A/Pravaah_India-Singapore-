import {
  buildAccountHandle,
  isOwnVpa,
  isReservedLocalPart,
  isValidVpa,
  maskAccountHandle,
  maskHandle,
  maskVpa,
  normaliseVpa,
  parseAccountHandle,
  parseVpa,
  vpaCandidates,
} from '@/modules/payments/vpa.util'

describe('vpa.util — parsing', () => {
  it('accepts a well-formed UPI ID', () => {
    expect(parseVpa('ravi.kumar@pravaah')).toEqual({
      localPart: 'ravi.kumar',
      handle: 'pravaah',
      vpa: 'ravi.kumar@pravaah',
    })
    expect(isValidVpa('9876543210@ybl')).toBe(true)
    expect(isValidVpa('a1@okhdfcbank')).toBe(true)
  })

  it('lower-cases so one address never becomes two beneficiary rows', () => {
    // Without this, `Ravi@Pravaah` and `ravi@pravaah` get separate
    // new-beneficiary cooling periods — and the ₹5,000 sliding cap is doubled by
    // changing one letter's case.
    expect(normaliseVpa('  Ravi@Pravaah  ')).toBe('ravi@pravaah')
    expect(parseVpa('RAVI@PRAVAAH')?.vpa).toBe('ravi@pravaah')
  })

  it('rejects addresses that only look payable', () => {
    expect(isValidVpa('ravi')).toBe(false) // no handle
    expect(isValidVpa('@pravaah')).toBe(false) // no local part
    expect(isValidVpa('ravi@')).toBe(false) // no handle
    expect(isValidVpa('ravi@@pravaah')).toBe(false) // two separators
    expect(isValidVpa('ravi@pravaah@evil')).toBe(false)
    expect(isValidVpa('ravi kumar@pravaah')).toBe(false) // whitespace inside
    expect(isValidVpa('ravi@1234')).toBe(false) // handle must start with a letter
    expect(isValidVpa('.ravi@pravaah')).toBe(false) // local part must start alnum
    expect(isValidVpa('a@b')).toBe(false) // handle too short
  })

  it('rejects an over-long address', () => {
    expect(isValidVpa(`${'a'.repeat(300)}@pravaah`)).toBe(false)
  })

  it('recognises our own handle', () => {
    expect(isOwnVpa('ravi@pravaah')).toBe(true)
    expect(isOwnVpa('ravi@ybl')).toBe(false)
  })
})

describe('vpa.util — reserved local parts', () => {
  it('refuses the addresses that would let a user impersonate us', () => {
    // Somebody holding `support@pravaah` or `refund@pravaah` can impersonate us to
    // every other user, and the resulting fraud is indistinguishable from an
    // official request.
    for (const reserved of ['admin', 'support', 'refund', 'payments', 'kyc']) {
      expect(isReservedLocalPart(reserved)).toBe(true)
      expect(isReservedLocalPart(reserved.toUpperCase())).toBe(true)
    }
    expect(isReservedLocalPart('ravi')).toBe(false)
  })
})

describe('vpa.util — allocation candidates', () => {
  it('derives a handle from a name', () => {
    const candidates = vpaCandidates('Ravi Kumar')
    expect(candidates[0]).toBe('ravi.kumar@pravaah')
    expect(candidates.every(isValidVpa)).toBe(true)
  })

  it('returns a list, so allocation can walk it against the unique index', () => {
    // Any "is it free?" check is stale the moment it returns, so allocation tries
    // candidates until the database accepts one.
    const candidates = vpaCandidates('Ravi Kumar')
    expect(candidates.length).toBeGreaterThan(1)
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('is deterministic for the same seed', () => {
    expect(vpaCandidates('Ravi Kumar')).toEqual(vpaCandidates('Ravi Kumar'))
  })

  it('never proposes a reserved handle', () => {
    expect(vpaCandidates('Support')).not.toContain('support@pravaah')
    expect(vpaCandidates('admin')).not.toContain('admin@pravaah')
  })

  it('produces something usable from a seed with no Latin characters', () => {
    // A name that normalises to nothing must not yield `@pravaah` with an empty
    // local part.
    const candidates = vpaCandidates('रवि कुमार')
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every(isValidVpa)).toBe(true)
  })

  it('collapses punctuation rather than emitting an invalid address', () => {
    const candidates = vpaCandidates("  ..O'Brien--Smith.. ")
    expect(candidates.every(isValidVpa)).toBe(true)
    expect(candidates[0]).toBe('o.brien.smith@pravaah')
  })
})

describe('vpa.util — masking', () => {
  it('masks a VPA but keeps the PSP handle', () => {
    // A full VPA in a log line is a directly payable address — the one field in a
    // transaction record that is immediately actionable by whoever reads it. The
    // handle stays because knowing the PSP is often why the log is being read.
    expect(maskVpa('ravi.kumar@pravaah')).toBe('ra******r@pravaah')
    expect(maskVpa('ab@pravaah')).toBe('a*@pravaah')
    expect(maskVpa('not-a-vpa')).toBe('***')
  })

  it('masks an account handle down to the last four digits', () => {
    expect(maskAccountHandle('123456789012|HDFC0001234')).toBe(
      'XXXXXXXX9012|HDFC0001234',
    )
    expect(maskAccountHandle('garbage')).toBe('***')
  })

  it('masks either kind without the caller knowing which', () => {
    // Used on error paths, where getting it wrong leaks a full account number into
    // a log precisely when something has already gone wrong.
    expect(maskHandle('ravi.kumar@pravaah')).toContain('@pravaah')
    expect(maskHandle('123456789012|HDFC0001234')).toContain('9012')
  })
})

describe('vpa.util — account handles', () => {
  it('round-trips an account handle', () => {
    const handle = buildAccountHandle('123456789012', 'hdfc0001234')
    expect(handle).toBe('123456789012|HDFC0001234')
    expect(parseAccountHandle(handle)).toEqual({
      accountNumber: '123456789012',
      ifsc: 'HDFC0001234',
    })
  })

  it('rejects a malformed handle instead of half-parsing it', () => {
    expect(parseAccountHandle('123456789012')).toBeNull()
    expect(parseAccountHandle('|HDFC0001234')).toBeNull()
    expect(parseAccountHandle('123|HDFC|extra')).toBeNull()
  })
})
