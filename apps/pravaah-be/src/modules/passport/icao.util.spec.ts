import { Country } from 'generated/prisma/client'

import {
  TD1_LINE_LENGTH,
  buildCredentialNumber,
  encodeTd1Mrz,
  icaoCheckDigit,
  icaoStateCode,
  mrzDate,
  mrzDocumentNumber,
  mrzName,
  mrzTransliterate,
  parseCredentialNumber,
  verifyTd1Mrz,
} from '@/modules/passport/icao.util'

describe('icao.util', () => {
  describe('check digit (7-3-1 mod 10)', () => {
    it('matches the worked examples in Doc 9303', () => {
      // The standard's own published vectors. Pinned because the whole point of a check
      // digit is that OTHER people's readers compute the same one.
      expect(icaoCheckDigit('D23145890734')).toBe(9)
      expect(icaoCheckDigit('340712')).toBe(7)
      expect(icaoCheckDigit('950712')).toBe(2)
      expect(icaoCheckDigit('L898902C3')).toBe(6)
    })

    it('treats filler as zero and letters as A=10…Z=35', () => {
      expect(icaoCheckDigit('<<<<<<')).toBe(0)
      // A=10, weight 7 → 70 mod 10 = 0.
      expect(icaoCheckDigit('A')).toBe(0)
      // B=11, weight 7 → 77 mod 10 = 7.
      expect(icaoCheckDigit('B')).toBe(7)
    })

    it('rejects a character that cannot appear in an MRZ', () => {
      // Silently treating it as filler would let two different documents produce the
      // same check digit.
      expect(() => icaoCheckDigit('AB!')).toThrow(/not valid in an MRZ/)
      expect(() => icaoCheckDigit('ab')).toThrow(/not valid in an MRZ/)
    })
  })

  describe('credential number', () => {
    it('formats as PR-CC-SEQUENCE-CHECK with a verifying check digit', () => {
      const number = buildCredentialNumber(Country.INDIA, '123')
      expect(number).toMatch(/^PR-IN-0000123-\d$/)
      expect(parseCredentialNumber(number)).toEqual({
        country: 'IN',
        sequence: '0000123',
      })
    })

    it('uses the right alpha-2 per country', () => {
      expect(buildCredentialNumber(Country.SINGAPORE, '7')).toMatch(/^PR-SG-/)
      expect(buildCredentialNumber(Country.BOTH, '7')).toMatch(/^PR-IN-/)
    })

    it('rejects a mistyped number rather than letting it reach a lookup', () => {
      // A wrong-person match is worse than a miss, which is why a failed checksum
      // returns null instead of a plausible-looking parse.
      const valid = buildCredentialNumber(Country.INDIA, '4242424')
      const lastDigit = Number(valid.slice(-1))
      const corrupted = `${valid.slice(0, -1)}${(lastDigit + 1) % 10}`

      expect(parseCredentialNumber(valid)).not.toBeNull()
      expect(parseCredentialNumber(corrupted)).toBeNull()
    })

    it('catches a single-digit substitution anywhere in the sequence', () => {
      const number = buildCredentialNumber(Country.INDIA, '1234567')
      for (let position = 6; position < 13; position += 1) {
        const digit = Number(number[position])
        if (Number.isNaN(digit)) continue
        const mutated =
          number.slice(0, position) +
          String((digit + 5) % 10) +
          number.slice(position + 1)
        if (mutated === number) continue
        expect(parseCredentialNumber(mutated)).toBeNull()
      }
    })

    it('is forgiving about case and whitespace', () => {
      const number = buildCredentialNumber(Country.INDIA, '55')
      expect(parseCredentialNumber(number.toLowerCase())).not.toBeNull()
      expect(parseCredentialNumber(` ${number} `)).not.toBeNull()
    })

    it('truncates an over-long sequence rather than producing a malformed number', () => {
      expect(buildCredentialNumber(Country.INDIA, '123456789')).toMatch(
        /^PR-IN-3456789-\d$/,
      )
    })

    it('reduces to sequence + check digit for the 9-character MRZ field', () => {
      // The full PRIN00001234 is twelve characters and would truncate inside TD1's
      // nine-character field, discarding the check digit that makes the number
      // self-verifying. The prefix is constant and the country is already its own MRZ
      // field, so dropping both loses nothing.
      const number = buildCredentialNumber(Country.INDIA, '123')
      const field = mrzDocumentNumber(number)

      expect(field).toHaveLength(8)
      expect(field.startsWith('0000123')).toBe(true)
      expect(field.slice(-1)).toBe(number.slice(-1))
    })

    it('falls back to the trailing characters for a foreign number', () => {
      // An imperfect MRZ still beats an un-printable card.
      expect(mrzDocumentNumber('LEGACY-999')).toBe('LEGACY999')
    })
  })

  describe('transliteration', () => {
    it('folds diacritics to their base letter', () => {
      expect(mrzTransliterate('José')).toBe('JOSE')
      expect(mrzTransliterate('Ångström')).toBe('AANGSTROEM')
    })

    it('expands the German-convention pairs the standard fixes', () => {
      expect(mrzTransliterate('Müller')).toBe('MUELLER')
      expect(mrzTransliterate('Öztürk')).toBe('OEZTUERK')
      expect(mrzTransliterate('Weiß')).toBe('WEISS')
    })

    it('replaces spaces, hyphens and punctuation with filler', () => {
      expect(mrzTransliterate("O'Brien-Smith")).toBe('OBRIEN<SMITH')
      expect(mrzTransliterate('Asha Devi')).toBe('ASHA<DEVI')
    })

    it('produces only MRZ-legal characters for any input', () => {
      // Anything that reaches the check-digit function must be in the restricted
      // alphabet, or encoding a name would throw at issuance time.
      // The legal alphabet is A–Z, 0–9 and `<` — digits included, which is what makes a
      // document number encodable at all.
      const output = mrzTransliterate('Ravi 123 !@# Kumār 李')
      expect(output).toMatch(/^[A-Z0-9<]+$/)
      expect(output).toContain('123')
      expect(() => icaoCheckDigit(output)).not.toThrow()
    })
  })

  describe('name field', () => {
    it('formats as SURNAME<<GIVEN<NAMES padded to the line width', () => {
      const line = mrzName('Sharma', 'Asha Rani')
      expect(line).toBe('SHARMA<<ASHA<RANI'.padEnd(TD1_LINE_LENGTH, '<'))
      expect(line.length).toBe(TD1_LINE_LENGTH)
    })

    it('handles a holder with no family name', () => {
      // Many Indian names have no surname. The field is left empty rather than having
      // the given name duplicated into it — an empty field is honest, a fabricated
      // surname on a document a landlord will check is not.
      expect(mrzName('', 'Meena')).toBe('<<MEENA'.padEnd(TD1_LINE_LENGTH, '<'))
    })

    it('truncates an over-long name to the exact field width', () => {
      const line = mrzName('Venkataraman'.repeat(3), 'Subramanian'.repeat(3))
      expect(line.length).toBe(TD1_LINE_LENGTH)
    })
  })

  describe('dates', () => {
    it('formats as YYMMDD in UTC', () => {
      expect(mrzDate(new Date('1995-07-12T00:00:00Z'))).toBe('950712')
      expect(mrzDate(new Date('2034-01-05T23:59:59Z'))).toBe('340105')
    })
  })

  describe('TD1 machine-readable zone', () => {
    const mrz = encodeTd1Mrz({
      documentCode: 'IP',
      issuingState: 'IND',
      documentNumber: '00001234',
      birthDate: new Date('1995-07-12T00:00:00Z'),
      sex: 'F',
      expiryDate: new Date('2026-01-20T00:00:00Z'),
      nationality: 'IND',
      familyName: 'Sharma',
      givenName: 'Asha',
      optionalData1: 'VERY_GOOD',
    })

    it('is three lines of exactly thirty characters', () => {
      expect(mrz.line1).toHaveLength(TD1_LINE_LENGTH)
      expect(mrz.line2).toHaveLength(TD1_LINE_LENGTH)
      expect(mrz.line3).toHaveLength(TD1_LINE_LENGTH)
    })

    it('lays out line 1 as code · state · number · check · optional', () => {
      expect(mrz.line1.slice(0, 2)).toBe('IP')
      expect(mrz.line1.slice(2, 5)).toBe('IND')
      // Eight characters of document number, filler-padded to the nine-character field.
      // Digits MUST survive transliteration — a regex of `[^A-Z]` would turn the whole
      // number into filler and produce a valid-looking MRZ identifying no document.
      expect(mrz.line1.slice(5, 14)).toBe('00001234<')
      expect(Number(mrz.line1[14])).toBe(icaoCheckDigit('00001234<'))
      expect(mrz.line1.slice(15)).toBe('VERY<GOOD<<<<<<')
    })

    it('lays out line 2 as birth · check · sex · expiry · check · nationality', () => {
      expect(mrz.line2.slice(0, 6)).toBe('950712')
      expect(Number(mrz.line2[6])).toBe(icaoCheckDigit('950712'))
      expect(mrz.line2[7]).toBe('F')
      expect(mrz.line2.slice(8, 14)).toBe('260120')
      expect(Number(mrz.line2[14])).toBe(icaoCheckDigit('260120'))
      expect(mrz.line2.slice(15, 18)).toBe('IND')
    })

    it('carries the name on line 3', () => {
      expect(mrz.line3).toBe('SHARMA<<ASHA'.padEnd(TD1_LINE_LENGTH, '<'))
    })

    it('verifies every check digit it wrote', () => {
      expect(verifyTd1Mrz(mrz)).toEqual({ valid: true, failures: [] })
    })

    it('detects tampering with the document number', () => {
      // The composite check digit is what makes the zone tamper-evident as a WHOLE
      // rather than field by field.
      const forged = {
        ...mrz,
        line1: `${mrz.line1.slice(0, 5)}XXXXXXXXX${mrz.line1.slice(14)}`,
      }
      const result = verifyTd1Mrz(forged)
      expect(result.valid).toBe(false)
      expect(result.failures).toContain('Document number check digit')
      expect(result.failures).toContain('Composite check digit')
    })

    it('detects tampering with the expiry date', () => {
      // 991230, not 991231: the 7-3-1 weighting gives 991231 the SAME check digit as
      // 260120, so that forgery would slip past the field-level digit and only be
      // caught by the composite. Picking a non-colliding date tests the field digit.
      const forged = {
        ...mrz,
        line2: `${mrz.line2.slice(0, 8)}991230${mrz.line2.slice(14)}`,
      }
      const result = verifyTd1Mrz(forged)
      expect(result.valid).toBe(false)
      expect(result.failures).toContain('Expiry date check digit')
    })

    it('encodes an undisclosed birth date and sex as valid filler', () => {
      // A credential that does not assert age must still produce a VALID MRZ. Filler
      // with a check digit computed over it is the honest encoding; a fabricated date
      // would not be.
      const undisclosed = encodeTd1Mrz({
        documentCode: 'IP',
        issuingState: 'SGP',
        documentNumber: '00099995',
        birthDate: null,
        sex: '<',
        expiryDate: new Date('2026-06-30T00:00:00Z'),
        nationality: 'SGP',
        familyName: 'Tan',
        givenName: 'Wei Ming',
      })

      expect(undisclosed.line2.slice(0, 6)).toBe('<<<<<<')
      expect(undisclosed.line2[7]).toBe('<')
      expect(verifyTd1Mrz(undisclosed)).toEqual({ valid: true, failures: [] })
    })

    it('rejects lines of the wrong length outright', () => {
      const result = verifyTd1Mrz({ line1: 'IP', line2: '', line3: '' })
      expect(result.valid).toBe(false)
      expect(result.failures[0]).toMatch(/30 characters/)
    })
  })

  describe('state codes', () => {
    it('maps to ISO 3166-1 alpha-3 for the MRZ', () => {
      expect(icaoStateCode(Country.INDIA)).toBe('IND')
      expect(icaoStateCode(Country.SINGAPORE)).toBe('SGP')
      expect(icaoStateCode(Country.BOTH)).toBe('IND')
    })
  })
})
