import { DISCLOSABLE_CLAIMS } from '@pravaah/schema'

import {
  CredentialStatus,
  ScoreBand,
  VerifierRequestStatus,
} from 'generated/prisma/client'

import {
  ALL_CLAIM_KEYS,
  THRESHOLD_CLAIMS,
  bandAtLeast,
  canTransition,
  dataRailsFor,
  describeCredentialClaims,
  isPresentable,
  isRequestOpen,
  isStatusListSet,
  kycLevel,
  partitionRequestedClaims,
  resolveTemplate,
  selectableClaims,
  splitVerifiedName,
  thresholdClaims,
  unsatisfiedClaims,
} from '@/modules/passport/passport.state'

describe('passport.state', () => {
  describe('credential lifecycle', () => {
    it('allows the transitions the lifecycle defines', () => {
      expect(canTransition(CredentialStatus.ISSUED, CredentialStatus.REVOKED)).toBe(true)
      expect(canTransition(CredentialStatus.ISSUED, CredentialStatus.SUSPENDED)).toBe(true)
      expect(canTransition(CredentialStatus.ISSUED, CredentialStatus.EXPIRED)).toBe(true)
      // A hold is reversible.
      expect(canTransition(CredentialStatus.SUSPENDED, CredentialStatus.ISSUED)).toBe(true)
    })

    it('makes REVOKED terminal', () => {
      // Un-revoking would let a credential a verifier already rejected start passing
      // again, and no verifier caches revocation with that possibility in mind. The user
      // re-issues instead, which mints a new credential number.
      for (const target of Object.values(CredentialStatus)) {
        expect(canTransition(CredentialStatus.REVOKED, target)).toBe(false)
      }
    })

    it('makes EXPIRED terminal for that credential', () => {
      for (const target of Object.values(CredentialStatus)) {
        expect(canTransition(CredentialStatus.EXPIRED, target)).toBe(false)
      }
    })

    it('sets the status-list bit for SUSPENDED as well as REVOKED', () => {
      // The hold/revocation distinction is OURS. To a verifier both must read "do not
      // accept" — fail-closed is the only safe reading while an investigation is open.
      expect(isStatusListSet(CredentialStatus.REVOKED)).toBe(true)
      expect(isStatusListSet(CredentialStatus.SUSPENDED)).toBe(true)
      expect(isStatusListSet(CredentialStatus.ISSUED)).toBe(false)
      // EXPIRED is provable from the credential's own `exp`, so it burns no bit.
      expect(isStatusListSet(CredentialStatus.EXPIRED)).toBe(false)
    })

    it('only lets an unexpired ISSUED credential be presented', () => {
      const future = new Date(Date.now() + 86_400_000)
      const past = new Date(Date.now() - 1_000)

      expect(isPresentable(CredentialStatus.ISSUED, future)).toBe(true)
      expect(isPresentable(CredentialStatus.ISSUED, past)).toBe(false)
      expect(isPresentable(CredentialStatus.SUSPENDED, future)).toBe(false)
      expect(isPresentable(CredentialStatus.REVOKED, future)).toBe(false)
      expect(isPresentable(CredentialStatus.ISSUED, null)).toBe(true)
    })
  })

  describe('verifier requests', () => {
    it('is open only while PENDING and unexpired', () => {
      const future = new Date(Date.now() + 60_000)
      const past = new Date(Date.now() - 60_000)

      expect(isRequestOpen(VerifierRequestStatus.PENDING, future)).toBe(true)
      expect(isRequestOpen(VerifierRequestStatus.PENDING, past)).toBe(false)
      // A single-use nonce cannot be answered twice.
      expect(isRequestOpen(VerifierRequestStatus.APPROVED, future)).toBe(false)
      expect(isRequestOpen(VerifierRequestStatus.CONSUMED, future)).toBe(false)
      expect(isRequestOpen(VerifierRequestStatus.DECLINED, future)).toBe(false)
    })
  })

  describe('threshold claims', () => {
    it('derives implication from the band ordering', () => {
      expect(bandAtLeast(ScoreBand.VERY_GOOD, ScoreBand.GOOD)).toBe(true)
      expect(bandAtLeast(ScoreBand.GOOD, ScoreBand.GOOD)).toBe(true)
      expect(bandAtLeast(ScoreBand.FAIR, ScoreBand.GOOD)).toBe(false)
    })

    it('mints ALL FOUR thresholds regardless of band', () => {
      // THE property that keeps selective disclosure intact. If only the TRUE assertions
      // were minted, the NUMBER of digests in `_sd` would vary with the band — and an
      // observer counting digests would learn the band without a single disclosure.
      const excellent = thresholdClaims(ScoreBand.EXCELLENT)
      const poor = thresholdClaims(ScoreBand.POOR)

      expect(Object.keys(excellent)).toHaveLength(THRESHOLD_CLAIMS.length)
      expect(Object.keys(poor)).toHaveLength(THRESHOLD_CLAIMS.length)
      expect(Object.keys(excellent).sort()).toEqual(Object.keys(poor).sort())
    })

    it('asserts the truth for each threshold', () => {
      expect(thresholdClaims(ScoreBand.VERY_GOOD)).toEqual({
        score_at_least_fair: true,
        score_at_least_good: true,
        score_at_least_very_good: true,
        score_at_least_excellent: false,
      })
      expect(thresholdClaims(ScoreBand.POOR)).toEqual({
        score_at_least_fair: false,
        score_at_least_good: false,
        score_at_least_very_good: false,
        score_at_least_excellent: false,
      })
    })

    it('omits an "at least POOR" claim', () => {
      // Always true for every possible score, so it would prove nothing and only add
      // noise to the disclosure picker.
      expect(Object.keys(thresholdClaims(ScoreBand.GOOD))).not.toContain(
        'score_at_least_poor',
      )
    })
  })

  describe('name splitting', () => {
    it('takes the last token as the family name', () => {
      expect(splitVerifiedName('Asha Rani Sharma')).toEqual({
        givenName: 'Asha Rani',
        familyName: 'Sharma',
      })
    })

    it('leaves the family name EMPTY for a single-token name', () => {
      // Many Indian names have no surname. Duplicating the given name into both fields
      // would fabricate a surname on a document a landlord will check.
      expect(splitVerifiedName('Meena')).toEqual({
        givenName: 'Meena',
        familyName: '',
      })
    })

    it('handles absent and whitespace-only names without throwing', () => {
      expect(splitVerifiedName(null)).toEqual({ givenName: '', familyName: '' })
      expect(splitVerifiedName('   ')).toEqual({ givenName: '', familyName: '' })
      expect(splitVerifiedName('  Ravi   Kumar  ')).toEqual({
        givenName: 'Ravi',
        familyName: 'Kumar',
      })
    })
  })

  describe('data rails', () => {
    it('never claims a rail that was not used', () => {
      // A verifier trusts the score BECAUSE of the rail behind it. Claiming one we did
      // not use would be the single lie that discredits every other claim.
      expect(dataRailsFor('INDIA')).toEqual(['AA-IN'])
      expect(dataRailsFor('SINGAPORE')).toEqual(['SGFinDex'])
      expect(dataRailsFor('BOTH')).toEqual(['AA-IN', 'SGFinDex'])
    })
  })

  describe('kyc level', () => {
    it('expresses CAPABILITIES rather than rail names', () => {
      // A verifier abroad cannot evaluate "Aadhaar OKYC + penny-drop"; they can evaluate
      // "government document + liveness". This also means adding a rail in M0 does not
      // change what the claim means.
      expect(
        kycLevel({
          governmentDocument: true,
          liveness: true,
          faceMatch: true,
          bankAccount: false,
          sanctionsScreened: true,
        }),
      ).toBe('GOV_DOC+LIVENESS+FACE_MATCH+SANCTIONS')
    })

    it('reports NONE when nothing was proven', () => {
      expect(
        kycLevel({
          governmentDocument: false,
          liveness: false,
          faceMatch: false,
          bankAccount: false,
          sanctionsScreened: false,
        }),
      ).toBe('NONE')
    })
  })

  describe('requested-claim partitioning', () => {
    it('separates known claims from names this credential type has never had', () => {
      const { known, unknown } = partitionRequestedClaims([
        'score_band',
        'annual_income',
        'given_name',
      ])
      expect(known).toEqual(['score_band', 'given_name'])
      // Reported rather than dropped: a partner integrating against a stale claim list
      // needs to know their request was narrowed.
      expect(unknown).toEqual(['annual_income'])
    })

    it('de-duplicates so a repeated claim renders once', () => {
      const { known } = partitionRequestedClaims([
        'score_band',
        'score_band',
        'score_band',
      ])
      expect(known).toEqual(['score_band'])
    })
  })

  describe('templates', () => {
    it('keeps the micro-loan template to a single boolean', () => {
      // The strongest privacy claim in the product, and a real, sufficient credit
      // decision. If this ever grows, that is a product regression.
      const template = resolveTemplate('DOMESTIC_MICRO_LOAN')
      expect(template.claims).toEqual(['score_at_least_good'])
      expect(template.purpose.length).toBeGreaterThan(10)
    })

    it('gives the cross-border template the passport binding', () => {
      const template = resolveTemplate('CROSS_BORDER_RENTAL')
      expect(template.claims).toContain('passport_number')
      expect(template.claims).toContain('nationality')
      // The BAND, not the exact score — a landlord does not need the number.
      expect(template.claims).toContain('score_band')
      expect(template.claims).not.toContain('score_value')
    })

    it('keeps the identity-only template free of financial claims', () => {
      const template = resolveTemplate('IDENTITY_ONLY')
      expect(
        template.claims.filter((claim) => claim.startsWith('score_')),
      ).toEqual([])
    })

    it('only ever names claims that exist in the catalogue', () => {
      for (const id of [
        'DOMESTIC_MICRO_LOAN',
        'DOMESTIC_LOAN',
        'CROSS_BORDER_RENTAL',
        'INSURANCE_PRICING',
        'IDENTITY_ONLY',
      ] as const) {
        const { unknown } = partitionRequestedClaims(resolveTemplate(id).claims)
        expect(unknown).toEqual([])
      }
    })
  })

  describe('unsatisfied claims', () => {
    it('distinguishes "not disclosed" from "false"', () => {
      // THE dangerous conflation. A verifier reading a missing `score_at_least_good` as
      // `false` would decline an applicant who is actually excellent and simply chose
      // not to answer.
      const disclosed = { score_at_least_good: false }
      expect(
        unsatisfiedClaims(['score_at_least_good', 'given_name'], disclosed),
      ).toEqual(['given_name'])
    })

    it('is empty when everything asked for was disclosed', () => {
      expect(unsatisfiedClaims(['a'], { a: 1 })).toEqual([])
    })
  })

  describe('selectableClaims', () => {
    it('drops claims the credential does not carry and says which', () => {
      const { selected, missing } = selectableClaims(
        ['score_band', 'passport_number'],
        ['score_band', 'given_name'],
      )
      expect(selected).toEqual(['score_band'])
      expect(missing).toEqual(['passport_number'])
    })
  })

  describe('claim descriptors', () => {
    it('describes every disclosable claim, flagging which are held', () => {
      const described = describeCredentialClaims(['score_band', 'given_name'])

      expect(described).toHaveLength(DISCLOSABLE_CLAIMS.length)
      // Not-held claims are RETURNED rather than hidden, so the picker can grey one out
      // with a reason. A missing row is just confusing.
      expect(described.find((d) => d.claim === 'score_band')?.held).toBe(true)
      expect(described.find((d) => d.claim === 'passport_number')?.held).toBe(false)
    })

    it('gives every claim a human label and a reason a verifier might ask', () => {
      // "needs passport_number" is not a decision a person can make. Every claim must
      // carry the sentence that makes consent meaningful.
      for (const descriptor of describeCredentialClaims([])) {
        expect(descriptor.label).not.toContain('_')
        expect(descriptor.label.length).toBeGreaterThan(2)
        expect(descriptor.detail.length).toBeGreaterThan(10)
        expect(descriptor.whyAsked.length).toBeGreaterThan(10)
        expect(['LOW', 'MEDIUM', 'HIGH']).toContain(descriptor.sensitivity)
      }
    })

    it('marks the identity-theft-grade claims HIGH', () => {
      const bySensitivity = new Map(
        describeCredentialClaims([]).map((d) => [d.claim, d.sensitivity]),
      )
      expect(bySensitivity.get('passport_number')).toBe('HIGH')
      expect(bySensitivity.get('birth_date')).toBe('HIGH')
      expect(bySensitivity.get('score_value')).toBe('HIGH')
      // A threshold assertion reveals the least of anything in the catalogue.
      expect(bySensitivity.get('score_at_least_good')).toBe('LOW')
    })
  })

  describe('claim key inventory', () => {
    it('covers the always-visible and disclosable sets with no duplicates', () => {
      expect(new Set(ALL_CLAIM_KEYS).size).toBe(ALL_CLAIM_KEYS.length)
      expect(ALL_CLAIM_KEYS).toContain('credential_number')
      expect(ALL_CLAIM_KEYS).toContain('score_value')
    })
  })
})
