/**
 * ICAO Doc 9303 conventions, applied to the Financial Reputation Passport.
 *
 * Doc 9303 is the standard that lets a passport issued in Tokyo be read at a
 * border in Lima. We borrow three of its ideas because they solve exactly the
 * cross-border problems M3 has:
 *
 *  - a CHECK DIGIT on the document number, so a transcription error is caught at
 *    the counter rather than becoming a wrong-person lookup,
 *  - a fixed-width MACHINE-READABLE ZONE, so any reader can parse the document
 *    without knowing anything about the issuer,
 *  - the TD1 form factor — which is, precisely, ID-1: the size of a bank card.
 *
 * Everything here is pure. No I/O, so every rule is unit-testable against the
 * worked examples in the standard.
 */

import type { Country } from 'generated/prisma/client'

/** ICAO filler character. Every unused position in an MRZ is `<`, never a space. */
export const MRZ_FILLER = '<'

/** TD1 is three lines of exactly thirty characters. */
export const TD1_LINE_LENGTH = 30

// ── check digits ────────────────────────────────────────────────────────────
/**
 * The 9303 weighting: 7, 3, 1 repeating, digits at face value, letters as
 * A=10…Z=35, filler as 0, then the sum modulo 10.
 *
 * It catches every single-character error and most transpositions — which are the
 * two mistakes a human copying a document number actually makes.
 */
export function icaoCheckDigit(input: string): number {
  const weights = [7, 3, 1]
  let sum = 0
  for (let i = 0; i < input.length; i += 1) {
    sum += charValue(input[i]!) * weights[i % 3]!
  }
  return sum % 10
}

function charValue(char: string): number {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48
  if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 55
  if (char === MRZ_FILLER) return 0
  // Anything else cannot appear in an MRZ. Treating it as filler would let two
  // different documents produce the same check digit.
  throw new Error(`Character "${char}" is not valid in an MRZ field`)
}

// ── credential number ───────────────────────────────────────────────────────
/**
 * `PR-IN-0000123-4` — issuer prefix, issuing state, sequence, check digit.
 *
 * Human-dictatable, self-checking, and carrying the issuing country the way a
 * passport number's context does. The sequence is RANDOM, not incremental: a
 * sequential number would publish how many passports Pravaah has issued and let
 * anyone enumerate credential numbers.
 */
export const CREDENTIAL_NUMBER_PREFIX = 'PR'
const SEQUENCE_LENGTH = 7

/** ISO 3166-1 alpha-3 for the MRZ's issuing-state field. */
export function icaoStateCode(country: Country): string {
  return country === 'SINGAPORE' ? 'SGP' : 'IND'
}

/** ISO 3166-1 alpha-2, used in the readable credential number and `nationality`. */
export function alpha2(country: Country): string {
  return country === 'SINGAPORE' ? 'SG' : 'IN'
}

/**
 * Build a credential number from a random sequence.
 *
 * The caller supplies the sequence so this stays pure and the issuer controls the
 * randomness source — the same split M0's Pravaah ID uses, and the reason both
 * are testable against fixed vectors.
 */
export function buildCredentialNumber(
  country: Country,
  sequence: string,
): string {
  const seq = sequence.padStart(SEQUENCE_LENGTH, '0').slice(-SEQUENCE_LENGTH)
  const cc = alpha2(country)
  // The check digit covers the concatenation WITHOUT dashes: dashes are
  // presentation, and a check digit that depended on them would break the moment
  // someone typed the number without them.
  const base = `${CREDENTIAL_NUMBER_PREFIX}${cc}${seq}`
  return `${CREDENTIAL_NUMBER_PREFIX}-${cc}-${seq}-${icaoCheckDigit(base)}`
}

const CREDENTIAL_NUMBER_PATTERN = /^PR-([A-Z]{2})-(\d{7})-(\d)$/

/**
 * Validate a credential number, checksum included. Returns null when it does not
 * verify, so a mistyped number never reaches a database lookup — a wrong-person
 * match is worse than a miss.
 */
export function parseCredentialNumber(
  input: string,
): { country: string; sequence: string } | null {
  const normalised = input.trim().toUpperCase().replace(/\s/g, '')
  const match = CREDENTIAL_NUMBER_PATTERN.exec(normalised)
  if (!match) return null
  const [, cc, seq, check] = match as unknown as [string, string, string, string]
  const expected = icaoCheckDigit(
    `${CREDENTIAL_NUMBER_PREFIX}${cc}${seq}`,
  ).toString()
  return expected === check ? { country: cc, sequence: seq } : null
}

/**
 * The MRZ document-number field: the sequence and its check digit, without the `PR`
 * prefix or the country code.
 *
 * TD1's document-number field is NINE characters. The full `PRIN00001234` is twelve, so
 * carrying it verbatim would truncate to `PRIN00001` — silently discarding the very
 * check digit that makes the number self-verifying, which is the opposite of what an
 * MRZ is for.
 *
 * Dropping the prefix is not a loss of information: `PR` is constant for every
 * credential we issue, and the issuing state already occupies its own field on line 1.
 * What remains — seven sequence digits plus the check digit — is eight characters, fits
 * with room to spare, and stays fully verifiable on its own.
 */
export function mrzDocumentNumber(credentialNumber: string): string {
  const parsed = parseCredentialNumber(credentialNumber)
  if (parsed) {
    const check = icaoCheckDigit(
      `${CREDENTIAL_NUMBER_PREFIX}${parsed.country}${parsed.sequence}`,
    )
    return `${parsed.sequence}${check}`
  }
  // Not one of our numbers (a legacy or hand-built credential). Fall back to the bare
  // characters rather than throwing: an imperfect MRZ still beats an un-printable card.
  return credentialNumber.replace(/-/g, '').slice(-9)
}

// ── MRZ field encoding ──────────────────────────────────────────────────────
/**
 * Transliterate arbitrary text into the MRZ's restricted alphabet (A–Z and `<`).
 *
 * Doc 9303 fixes the substitutions for the cases that matter here: spaces and
 * hyphens become filler, and diacritics fold to their base letter — `Ö` to `OE`
 * in the German convention the standard adopts, `É` to `E`. Getting this wrong
 * produces an MRZ whose name field does not match the printed page, which is a
 * document a border officer is trained to treat as suspect.
 */
export function mrzTransliterate(input: string): string {
  const expansions: Record<string, string> = {
    Ä: 'AE',
    Ö: 'OE',
    Ü: 'UE',
    ß: 'SS',
    Æ: 'AE',
    Ø: 'OE',
    Å: 'AA',
  }

  return input
    .toUpperCase()
    .split('')
    .map((char) => expansions[char] ?? char)
    .join('')
    // Decompose, then drop the combining marks: É → E + ́  → E.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['`´]/g, '')
    // DIGITS ARE LEGAL. The MRZ alphabet is A–Z, 0–9 and `<`; excluding digits here
    // would silently turn every document number into filler, producing a valid-looking
    // MRZ that identifies no document at all.
    .replace(/[^A-Z0-9]/g, MRZ_FILLER)
}

/** Pad or truncate to an exact field width, filler-padded on the right. */
export function mrzField(value: string, length: number): string {
  return value.padEnd(length, MRZ_FILLER).slice(0, length)
}

/**
 * The name field: `SURNAME<<GIVEN<NAMES`, filler-padded.
 *
 * Truncation is by design when a name exceeds the field. A passport does the same
 * thing, and silently dropping the surname instead would produce a document that
 * identifies the wrong person.
 */
export function mrzName(
  familyName: string,
  givenName: string,
  length = TD1_LINE_LENGTH,
): string {
  const family = mrzTransliterate(familyName).replace(/<+$/, '')
  const given = mrzTransliterate(givenName).replace(/<+$/, '')
  return mrzField(`${family}<<${given}`, length)
}

/** `YYMMDD`, the only date format an MRZ uses. */
export function mrzDate(date: Date): string {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

export interface Td1Input {
  /** Two characters; `IP` is the 9303 code for an identity card / ID document. */
  documentCode: string
  /** ISO 3166-1 alpha-3 issuing state. */
  issuingState: string
  /** The credential number, dashes stripped. */
  documentNumber: string
  birthDate: Date | null
  /** `M`, `F`, or `<` when not disclosed — the MRZ has no other option. */
  sex: 'M' | 'F' | '<'
  expiryDate: Date
  /** ISO 3166-1 alpha-3 nationality. */
  nationality: string
  familyName: string
  givenName: string
  /** Optional data, line 1 (15 chars) — we carry the score band. */
  optionalData1?: string
  /** Optional data, line 2 (11 chars) — we carry the model version. */
  optionalData2?: string
}

export interface Td1Mrz {
  line1: string
  line2: string
  line3: string
}

/**
 * Encode a TD1 three-line machine-readable zone.
 *
 * Layout, straight from Doc 9303 Part 5:
 *
 *   Line 1  doc code (2) · issuing state (3) · doc number (9) · check (1) ·
 *           optional data (15)
 *   Line 2  birth date (6) · check (1) · sex (1) · expiry (6) · check (1) ·
 *           nationality (3) · optional data (11) · COMPOSITE check (1)
 *   Line 3  name (30)
 *
 * The composite check digit on line 2 covers a specific, non-contiguous span of
 * both lines — positions 6–30 of line 1 and 1–7, 9–15, 19–29 of line 2. It is
 * what makes the zone tamper-evident as a whole rather than field by field, and
 * the exact span is why it is spelled out here rather than computed over
 * "everything".
 */
export function encodeTd1Mrz(input: Td1Input): Td1Mrz {
  const docNumber = mrzField(mrzTransliterate(input.documentNumber), 9)
  const docNumberCheck = icaoCheckDigit(docNumber)

  const line1 = mrzField(
    `${mrzField(input.documentCode, 2)}${mrzField(input.issuingState, 3)}${docNumber}${docNumberCheck}${mrzField(
      mrzTransliterate(input.optionalData1 ?? ''),
      15,
    )}`,
    TD1_LINE_LENGTH,
  )

  // An undisclosed birth date is all-filler, and its check digit is computed over
  // that filler — a valid MRZ for a document that simply does not assert age.
  const birth = input.birthDate
    ? mrzDate(input.birthDate)
    : MRZ_FILLER.repeat(6)
  const birthCheck = icaoCheckDigit(birth)
  const expiry = mrzDate(input.expiryDate)
  const expiryCheck = icaoCheckDigit(expiry)

  const line2Prefix = `${birth}${birthCheck}${input.sex}${expiry}${expiryCheck}${mrzField(
    input.nationality,
    3,
  )}${mrzField(mrzTransliterate(input.optionalData2 ?? ''), 11)}`

  const composite =
    line1.slice(5, 30) +
    line2Prefix.slice(0, 7) +
    line2Prefix.slice(8, 15) +
    line2Prefix.slice(18, 29)
  const line2 = mrzField(
    `${line2Prefix}${icaoCheckDigit(composite)}`,
    TD1_LINE_LENGTH,
  )

  return {
    line1,
    line2,
    line3: mrzName(input.familyName, input.givenName),
  }
}

/**
 * Re-derive every check digit in a TD1 zone and report which ones disagree.
 *
 * Exposed rather than kept private because a verifier reading the printed card
 * (no NFC, no QR — a photocopy) needs exactly this, and because it is what makes
 * the encoder testable against the standard's own worked examples.
 */
export function verifyTd1Mrz(mrz: Td1Mrz): {
  valid: boolean
  failures: string[]
} {
  const failures: string[] = []
  if (
    mrz.line1.length !== TD1_LINE_LENGTH ||
    mrz.line2.length !== TD1_LINE_LENGTH ||
    mrz.line3.length !== TD1_LINE_LENGTH
  ) {
    return { valid: false, failures: ['Each MRZ line must be 30 characters'] }
  }

  try {
    if (icaoCheckDigit(mrz.line1.slice(5, 14)) !== Number(mrz.line1[14])) {
      failures.push('Document number check digit')
    }
    if (icaoCheckDigit(mrz.line2.slice(0, 6)) !== Number(mrz.line2[6])) {
      failures.push('Birth date check digit')
    }
    if (icaoCheckDigit(mrz.line2.slice(8, 14)) !== Number(mrz.line2[14])) {
      failures.push('Expiry date check digit')
    }
    const composite =
      mrz.line1.slice(5, 30) +
      mrz.line2.slice(0, 7) +
      mrz.line2.slice(8, 15) +
      mrz.line2.slice(18, 29)
    if (icaoCheckDigit(composite) !== Number(mrz.line2[29])) {
      failures.push('Composite check digit')
    }
  } catch (error) {
    failures.push((error as Error).message)
  }

  return { valid: failures.length === 0, failures }
}
