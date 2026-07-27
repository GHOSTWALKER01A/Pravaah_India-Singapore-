import { z } from 'zod'

/**
 * The Pravaah ID — a user's permanent, public identity in the network.
 *
 *     PVH-4K7Q-M2XB-9T3F
 *
 * This is the number a user reads out to a lender, a reviewer quotes in a case
 * note, and a partner types into the verify flow. It is deliberately NOT the
 * row UUID: a UUID is 36 characters of hex that nobody can read, dictate, or
 * transcribe, and exposing it publishes an internal database key.
 *
 * Design constraints, and how the format meets each:
 *
 *   Immutable    Minted once at provisioning and never rewritten. Nothing about
 *                the user is encoded in it — not country, not signup order — so
 *                there is no fact that can later make the ID wrong.
 *   Opaque       Random, never sequential, so the ID leaks neither the user
 *                count nor enrolment order, and cannot be enumerated.
 *   Transcribable Crockford Base32 drops I, L, O and U, so there is no 1/I/l or
 *                0/O ambiguity to resolve, and no accidental profanity. Reading
 *                one aloud over a phone line is unambiguous.
 *   Self-checking The final character is a Luhn mod-32 check symbol over the
 *                other eleven, so a mistyped or misheard ID is caught locally —
 *                before it becomes a database lookup or a wrong-person match.
 *   Forgiving    {@link normalizePravaahId} accepts lower case, missing dashes,
 *                a missing prefix, and the I/L/O confusions, then returns the
 *                one canonical spelling.
 *
 * Entropy is 11 symbols x 5 bits = 55 bits (~3.6e16 IDs). At 100M users the
 * chance any single mint collides is ~3e-9; the unique index plus the issuer's
 * retry loop make a collision a retried insert rather than a defect.
 */

/** Brand segment. Every Pravaah ID starts with this. */
export const PRAVAAH_ID_PREFIX = 'PVH'

/**
 * Crockford Base32: the digits, then the letters minus I, L, O and U. Order is
 * significant — a symbol's index IS its value, for both encoding and the check
 * character — so this string must never be reordered.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BASE = ALPHABET.length // 32

/** Random symbols in an ID, excluding the trailing check symbol. */
export const PRAVAAH_ID_ENTROPY_SYMBOLS = 11

/** Total symbols in an ID body: the random run plus the check symbol. */
export const PRAVAAH_ID_SYMBOLS = PRAVAAH_ID_ENTROPY_SYMBOLS + 1 // 12

/** Canonical rendered length, e.g. `PVH-4K7Q-M2XB-9T3F`. */
export const PRAVAAH_ID_LENGTH = 18

/** Matches the canonical rendering exactly (checksum NOT verified — see {@link isPravaahId}). */
export const PRAVAAH_ID_PATTERN = new RegExp(
  `^${PRAVAAH_ID_PREFIX}-[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`,
)

/**
 * Luhn mod N over Base32: the check symbol that makes `body + check` valid.
 *
 * Chosen over a plain sum because Luhn's alternating weights catch every
 * single-symbol substitution AND all but one adjacent transposition — the two
 * mistakes people actually make when copying a code by hand or by ear.
 *
 * The one blind spot is exact and known: swapping an adjacent `0` and `Z` is not
 * detected, at any position. Luhn mod N misses a transposition of values a and b
 * when `fold(2a) - a ≡ fold(2b) - b (mod N)`, and over 32 symbols the only such
 * pair is (0, 31). That is 1 of 496 symbol pairs; the property is pinned by test
 * so any change to the alphabet or the algorithm has to restate its coverage.
 */
function checkSymbol(body: string): string {
  let factor = 2
  let sum = 0
  // Right to left: the weight of a symbol must not shift when the body grows.
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const value = ALPHABET.indexOf(body[i])
    if (value < 0) throw new Error(`Not a Base32 symbol: ${body[i]}`)
    const addend = factor * value
    factor = factor === 2 ? 1 : 2
    // Fold the overflow back in, exactly as Luhn folds a two-digit product.
    sum += Math.floor(addend / BASE) + (addend % BASE)
  }
  return ALPHABET[(BASE - (sum % BASE)) % BASE]
}

/** Groups a 12-symbol body into the canonical `PVH-XXXX-XXXX-XXXX` rendering. */
function render(body: string): string {
  return `${PRAVAAH_ID_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`
}

/**
 * Builds a Pravaah ID from exactly {@link PRAVAAH_ID_ENTROPY_SYMBOLS} bytes of
 * entropy.
 *
 * Kept pure, with the caller supplying the bytes, so this module stays free of
 * any platform crypto import and can be shared by the API, the console and the
 * app. Callers MUST pass cryptographically random bytes — see the issuer in
 * `apps/pravaah-be/src/modules/users/pravaah-id.service.ts`.
 *
 * `byte % 32` is exactly uniform here because 256 is a multiple of 32, so there
 * is no modulo bias to reject-sample away.
 */
export function buildPravaahId(entropy: Uint8Array): string {
  if (entropy.length !== PRAVAAH_ID_ENTROPY_SYMBOLS) {
    throw new Error(
      `Pravaah ID needs exactly ${PRAVAAH_ID_ENTROPY_SYMBOLS} entropy bytes, got ${entropy.length}`,
    )
  }
  let body = ''
  for (const byte of entropy) body += ALPHABET[byte % BASE]
  return render(body + checkSymbol(body))
}

/**
 * Coerces any human spelling of a Pravaah ID to its canonical form, or returns
 * null if it is not a valid ID.
 *
 * Accepts lower case, spaces, missing or repeated dashes, a missing `PVH`
 * prefix, and the Crockford substitutions (I/i/L/l -> 1, O/o -> 0) — i.e. what
 * people actually type and dictate. Rejects anything whose check symbol does
 * not verify, so a plausible-looking typo never reaches a lookup.
 */
export function normalizePravaahId(input: string): string | null {
  if (typeof input !== 'string') return null

  let cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, '')

  // The prefix is optional on input — a user copying the number often drops it —
  // but P, V and H are themselves valid Base32 symbols, so a leading "PVH" is
  // only a prefix when the length says so. Deciding by length instead of by
  // match keeps a bare ID whose body starts with PVH from losing 3 symbols.
  if (cleaned.length === PRAVAAH_ID_PREFIX.length + PRAVAAH_ID_SYMBOLS) {
    if (!cleaned.startsWith(PRAVAAH_ID_PREFIX)) return null
    cleaned = cleaned.slice(PRAVAAH_ID_PREFIX.length)
  }
  if (cleaned.length !== PRAVAAH_ID_SYMBOLS) return null

  // Crockford's transcription rules — applied AFTER the prefix is stripped, so
  // the 'V' in PVH is never a substitution candidate.
  cleaned = cleaned.replace(/[IL]/g, '1').replace(/O/g, '0')

  // U is excluded from the alphabet and has no transcription rule, so any
  // remaining out-of-alphabet symbol is a genuine error.
  for (const symbol of cleaned) {
    if (!ALPHABET.includes(symbol)) return null
  }

  const body = cleaned.slice(0, PRAVAAH_ID_ENTROPY_SYMBOLS)
  const check = cleaned[PRAVAAH_ID_ENTROPY_SYMBOLS]
  if (checkSymbol(body) !== check) return null

  return render(cleaned)
}

/** True when `input` is a Pravaah ID in any accepted spelling, checksum included. */
export function isPravaahId(input: string): boolean {
  return normalizePravaahId(input) !== null
}

/**
 * A Pravaah ID on the wire. Validates the checksum and normalizes, so a handler
 * receiving this always holds the canonical spelling — never a variant that
 * would miss on a database lookup.
 */
export const PravaahIdSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const canonical = normalizePravaahId(value)
    if (!canonical) {
      ctx.addIssue({
        code: 'custom',
        message: 'Not a valid Pravaah ID (expected PVH-XXXX-XXXX-XXXX)',
      })
      return z.NEVER
    }
    return canonical
  })

export type PravaahId = z.infer<typeof PravaahIdSchema>
