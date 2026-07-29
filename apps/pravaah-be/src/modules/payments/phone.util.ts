/**
 * Phone numbers as PAYMENT ADDRESSES.
 *
 * A mobile number is the address people actually know. Nobody has their friend's VPA memorised, but
 * everybody has their number — which is why "to mobile" is the first tile in every Indian UPI app and
 * why PayNow made the number a first-class proxy. This file is the translation layer between a number
 * a human types and something a rail can be asked about.
 *
 * The two corridors work fundamentally differently, and conflating them would be the central mistake:
 *
 * - **India (UPI).** There is no public directory that maps a mobile number to a VPA. What exists is
 *   a near-universal CONVENTION: a PSP registers `<mobile>@<its-handle>` for its users. So an Indian
 *   lookup is a *search over candidates*, it can return more than one hit, and it can legitimately
 *   return none while the person is still perfectly reachable at a VPA they chose themselves.
 * - **Singapore (PayNow).** The mobile number IS the proxy, registered once in a central directory.
 *   One number resolves to exactly one account, or to nothing. No candidates, no guessing.
 *
 * Because of that asymmetry, nothing here ever claims a number is "invalid" when it merely failed to
 * resolve. Those are different facts and a user told the first when the second is true will believe
 * they mistyped their mother's number.
 */

/** E.164 country calling codes for the two corridors this product serves. */
export const DIALLING_CODE = { IN: '91', SG: '65' } as const

export type PhoneCountry = keyof typeof DIALLING_CODE

export interface ParsedPhone {
  country: PhoneCountry
  /** The national number, digits only — `9876543210`, `81234567`. */
  national: string
  /** Canonical E.164, with `+`. The form stored and logged. */
  e164: string
}

/**
 * Strip everything that is not a digit, and drop a leading `+` or `00`.
 *
 * People paste numbers from contact lists, so the input genuinely arrives as `+91 98765-43210`,
 * `098765 43210` and `0091 9876543210`. Rejecting those would be rejecting correct numbers on
 * formatting grounds.
 */
function digitsOf(raw: string): string {
  const digits = raw.replace(/\D+/g, '')
  return digits.startsWith('00') ? digits.slice(2) : digits
}

/**
 * Indian mobile numbers: exactly 10 digits, first digit 6–9.
 *
 * The leading-digit rule is real and worth enforcing — 1–5 are landline trunk and service ranges, so
 * a 10-digit string starting with 2 is not a mobile and no UPI PSP will have registered it. Catching
 * that here saves a pointless rail round trip and lets the message be specific.
 */
const IN_MOBILE = /^[6-9]\d{9}$/

/**
 * Singapore mobile numbers: 8 digits, first digit 8 or 9.
 *
 * 3 and 6 are also assignable in SG but are landline/VoIP ranges, and PayNow's mobile proxy is
 * specifically a mobile registration.
 */
const SG_MOBILE = /^[89]\d{7}$/

/**
 * Parse a typed number for a chosen country.
 *
 * The country comes from the caller — a picker in the UI — rather than being inferred from the digits.
 * Inference is genuinely ambiguous here: `8123456789` is ten digits and could be an Indian mobile, or
 * a Singapore number someone typed with an extra digit. Getting that wrong sends money to a stranger
 * in the wrong country, so the country is always stated, never guessed.
 */
export function parsePhone(
  raw: string,
  country: PhoneCountry,
): ParsedPhone | null {
  let digits = digitsOf(raw)
  const code = DIALLING_CODE[country]

  // Tolerate the country code being included, either as typed or pasted.
  if (digits.startsWith(code)) {
    const withoutCode = digits.slice(code.length)
    if (isNationalMobile(withoutCode, country)) digits = withoutCode
  }

  // A single leading trunk zero is how Indian numbers are commonly written.
  if (country === 'IN' && digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1)
  }

  if (!isNationalMobile(digits, country)) return null

  return { country, national: digits, e164: `+${code}${digits}` }
}

function isNationalMobile(digits: string, country: PhoneCountry): boolean {
  return country === 'IN' ? IN_MOBILE.test(digits) : SG_MOBILE.test(digits)
}

export function isMobileNumber(raw: string, country: PhoneCountry): boolean {
  return parsePhone(raw, country) !== null
}

/**
 * Mask a number for display and for logs.
 *
 * Last two digits only. A payee list is one screenshot from being shared, and a full mobile number is
 * both a directly payable address and personal data about a third party who never consented to appear
 * in our logs.
 */
export function maskPhone(raw: string, country: PhoneCountry = 'IN'): string {
  const parsed = parsePhone(raw, country)
  if (!parsed) {
    const digits = digitsOf(raw)
    return digits.length <= 2 ? '••' : `••••${digits.slice(-2)}`
  }
  const { national, country: c } = parsed
  return `+${DIALLING_CODE[c]} ${'•'.repeat(national.length - 2)}${national.slice(-2)}`
}

/**
 * The VPA candidates an Indian mobile number could be registered as.
 *
 * Ordered deliberately, because the order decides both cost and correctness:
 *
 * 1. **Our own suffix first.** A `@pravaah` hit is answered from our database with no rail call at
 *    all, and it settles internally rather than over UPI. It is the cheapest and the most likely for
 *    the corridor this product serves — a family already on Pravaah on both sides.
 * 2. **Then the configured PSP suffixes**, in the order given.
 *
 * `limit` exists because each candidate past the first is a real rail round trip against a
 * rate-limited API. Probing twenty handles to find one person would make a single tap cost twenty
 * calls, and PSPs will throttle exactly that pattern.
 */
export function mobileVpaCandidates(
  national: string,
  ownSuffix: string,
  pspSuffixes: readonly string[],
  limit = 6,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const suffix of [ownSuffix, ...pspSuffixes]) {
    const clean = suffix.trim().toLowerCase().replace(/^@/, '')
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(`${national}@${clean}`)
    if (out.length >= limit) break
  }

  return out
}

/**
 * The PayNow proxy for a Singapore mobile.
 *
 * PayNow addresses a mobile proxy in E.164 with the `+`, and that is not cosmetic: `+6581234567` and
 * `81234567` are different strings to the directory, and the second one does not resolve.
 */
export function payNowMobileProxy(parsed: ParsedPhone): string {
  return parsed.e164
}
