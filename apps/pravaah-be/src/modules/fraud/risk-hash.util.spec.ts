import {
  HASH_NS,
  hashDevice,
  hashIdentifier,
  hashIpNetwork,
  hashMobile,
  hashVpa,
  hashesEqual,
  ipNetwork,
  normalisePhoneForHash,
  normaliseForHash,
  resetRiskHashKeyCache,
  riskHash,
} from '@/modules/fraud/risk-hash.util'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.RISK_HASH_KEY = 'test-risk-hash-key-not-a-real-secret'
  resetRiskHashKeyCache()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  resetRiskHashKeyCache()
})

describe('riskHash', () => {
  it('is deterministic for the same namespace and value', () => {
    expect(riskHash(HASH_NS.VPA, 'ravi@ybl')).toBe(
      riskHash(HASH_NS.VPA, 'ravi@ybl'),
    )
  })

  it('produces a 64-character hex digest', () => {
    expect(riskHash(HASH_NS.VPA, 'ravi@ybl')).toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * The namespace separation that stops a phone number listed as a MOBILE from
   * accidentally matching an unrelated VPA local part.
   */
  it('gives different digests for the same value in different namespaces', () => {
    const value = '9876543210'
    expect(riskHash(HASH_NS.MOBILE, value)).not.toBe(
      riskHash(HASH_NS.VPA, value),
    )
    expect(riskHash(HASH_NS.DEVICE, value)).not.toBe(
      riskHash(HASH_NS.USER, value),
    )
  })

  /**
   * The NUL separator. With plain concatenation, namespace `"DEVICE"` + value `"1X"`
   * would collide with namespace `"DEVICE1"` + value `"X"` — an unforgeable split point
   * is what makes namespacing meaningful rather than decorative.
   */
  it('cannot be made to collide by shifting the namespace boundary', () => {
    expect(riskHash('device', '1X')).not.toBe(riskHash('device1', 'X'))
    expect(riskHash('a', 'bc')).not.toBe(riskHash('ab', 'c'))
  })

  /**
   * The whole reason this is an HMAC and not a bare sha256: without the key, a VPA or a
   * ten-digit mobile number is brute-forceable in minutes.
   */
  it('changes completely when the key changes', () => {
    const withFirstKey = riskHash(HASH_NS.VPA, 'ravi@ybl')

    process.env.RISK_HASH_KEY = 'a-completely-different-key'
    resetRiskHashKeyCache()

    expect(riskHash(HASH_NS.VPA, 'ravi@ybl')).not.toBe(withFirstKey)
  })

  /**
   * A hard-coded default would make every deployment's hashes identical and therefore
   * precomputable — the single failure that would render this file decorative while it
   * continued to report success.
   */
  it('refuses to hash with no key configured', () => {
    delete process.env.RISK_HASH_KEY
    delete process.env.FIELD_ENCRYPTION_KEY
    resetRiskHashKeyCache()

    expect(() => riskHash(HASH_NS.VPA, 'ravi@ybl')).toThrow(/RISK_HASH_KEY/)
  })

  it('falls back to FIELD_ENCRYPTION_KEY so no environment is unsalted', () => {
    delete process.env.RISK_HASH_KEY
    process.env.FIELD_ENCRYPTION_KEY = 'fallback-key'
    resetRiskHashKeyCache()

    expect(() => riskHash(HASH_NS.VPA, 'ravi@ybl')).not.toThrow()
  })
})

describe('normaliseForHash', () => {
  /**
   * An equality-only hash is only as good as its canonical form. Three spellings of one
   * payment address must produce one digest, or a blocklist matches only the exact
   * string an analyst happened to type.
   */
  it('case-folds and collapses whitespace', () => {
    expect(normaliseForHash('  Ravi@YBL  ')).toBe('ravi@ybl')
    expect(normaliseForHash('Ravi   Kumar')).toBe('ravi kumar')
  })

  it('makes case and padding variants hash identically', () => {
    expect(hashVpa('Ravi@YBL')).toBe(hashVpa('ravi@ybl '))
  })

  /**
   * Punctuation is deliberately PRESERVED. Stripping it would merge `ravi.kumar@ybl`
   * and `ravikumar@ybl`, which under UPI's rules are different addresses belonging to
   * potentially different people — over-matching a blocklist onto an innocent payee is
   * its own failure.
   */
  it('does not strip punctuation', () => {
    expect(hashVpa('ravi.kumar@ybl')).not.toBe(hashVpa('ravikumar@ybl'))
  })
})

describe('normalisePhoneForHash / hashMobile', () => {
  it('reduces every formatting variant to one E.164 form', () => {
    expect(normalisePhoneForHash('+91 98765 43210')).toBe('+919876543210')
    expect(normalisePhoneForHash('919876543210')).toBe('+919876543210')
    expect(normalisePhoneForHash('+91-98765-43210')).toBe('+919876543210')
  })

  it('makes formatting variants hash identically', () => {
    const digest = hashMobile('+919876543210')
    expect(hashMobile('+91 98765 43210')).toBe(digest)
    expect(hashMobile('919876543210')).toBe(digest)
  })

  it('returns an empty string for a number with no digits', () => {
    expect(normalisePhoneForHash('not-a-number')).toBe('')
  })
})

describe('ipNetwork', () => {
  /**
   * Truncated before hashing. A residential IP is reassigned constantly, so an
   * exact-address counter decays to noise within hours while an attacker rotating
   * through a subnet defeats it entirely. The /24 is the unit a botnet occupies.
   */
  it('truncates IPv4 to a /24', () => {
    expect(ipNetwork('203.0.113.5')).toBe('203.0.113.0/24')
    expect(ipNetwork('203.0.113.200')).toBe('203.0.113.0/24')
  })

  it('groups every host in a /24 into one network', () => {
    expect(hashIpNetwork('203.0.113.5')).toBe(hashIpNetwork('203.0.113.99'))
  })

  it('separates different /24s', () => {
    expect(hashIpNetwork('203.0.113.5')).not.toBe(hashIpNetwork('203.0.114.5'))
  })

  it('truncates IPv6 to a /48', () => {
    expect(ipNetwork('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48')
  })

  /**
   * An IPv4-mapped IPv6 address is the SAME client. Without unmapping, one caller seen
   * over a v4 and a v6 socket would count as two networks and halve their apparent
   * velocity.
   */
  it('unmaps IPv4-mapped IPv6 so one client is one network', () => {
    expect(hashIpNetwork('::ffff:203.0.113.5')).toBe(
      hashIpNetwork('203.0.113.5'),
    )
  })

  it('passes through a value it cannot parse rather than throwing', () => {
    expect(ipNetwork('unknown')).toBe('unknown')
    expect(() => hashIpNetwork('unknown')).not.toThrow()
  })
})

describe('hashIdentifier', () => {
  it('normalises an email by case', () => {
    expect(hashIdentifier('User@Example.com')).toBe(
      hashIdentifier('user@example.com'),
    )
  })

  it('normalises a phone by formatting', () => {
    expect(hashIdentifier('+91 98765 43210')).toBe(
      hashIdentifier('+919876543210'),
    )
  })

  /**
   * Its own namespace, separate from MOBILE. The questions differ — this counts failed
   * logins per identifier, MOBILE checks a blocklist — and sharing a namespace would let
   * a stuffing counter collide with a list lookup.
   */
  it('is namespaced apart from a mobile blocklist entry', () => {
    expect(hashIdentifier('+919876543210')).not.toBe(
      hashMobile('+919876543210'),
    )
  })
})

describe('hashesEqual', () => {
  it('matches identical digests', () => {
    const digest = hashDevice('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    expect(hashesEqual(digest, digest)).toBe(true)
  })

  it('rejects different digests', () => {
    expect(hashesEqual(hashDevice('a'), hashDevice('b'))).toBe(false)
  })

  /**
   * `timingSafeEqual` throws on a length mismatch, so the guard is required. Leaking the
   * length is safe — the length of a sha256 digest is public.
   */
  it('rejects a length mismatch without throwing', () => {
    expect(hashesEqual('short', hashDevice('a'))).toBe(false)
    expect(hashesEqual('', '')).toBe(true)
  })
})
