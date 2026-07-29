import { VPA_REGEX } from '@pravaah/schema'

import {
  DEFAULT_VPA_SUFFIX,
  RESERVED_VPA_LOCALPARTS,
} from '@/modules/payments/payments.config'

/**
 * UPI address handling — pure, no I/O.
 *
 * A VPA is the highest-consequence string in the product. Money is PUSHED to it
 * with no confirmation step of its own, so an address that merely looks plausible
 * is not a validation problem, it is a stranger receiving somebody's rent. Every
 * function here is deliberately strict and every one normalises, because the two
 * ways this goes wrong are accepting an address that should not exist and treating
 * one address as two.
 */

export interface ParsedVpa {
  /** The part before the `@`. */
  localPart: string
  /** The PSP handle after the `@`. */
  handle: string
  /** The normalised, canonical form. */
  vpa: string
}

/**
 * Canonicalise a VPA: trimmed, lower-cased.
 *
 * UPI handles are case-insensitive, so `Ravi@Pravaah` and `ravi@pravaah` are one
 * address. Without normalisation they become two `Beneficiary` rows — which means
 * two separate new-beneficiary cooling periods against the same payee, and the
 * ₹5,000 sliding cap is trivially doubled by changing one letter's case.
 */
export function normaliseVpa(raw: string): string {
  return raw.trim().toLowerCase()
}

export function parseVpa(raw: string): ParsedVpa | null {
  const vpa = normaliseVpa(raw)
  if (vpa.length < 4 || vpa.length > 256) return null
  if (!VPA_REGEX.test(vpa)) return null

  // Exactly one `@`. The regex already forbids a second, but this is the
  // assumption every caller below depends on, so it is checked rather than
  // trusted to a regex somebody may later relax.
  const parts = vpa.split('@')
  if (parts.length !== 2) return null
  const [localPart, handle] = parts
  if (!localPart || !handle) return null

  return { localPart, handle, vpa }
}

export function isValidVpa(raw: string): boolean {
  return parseVpa(raw) !== null
}

/** Whether a VPA is one of ours (`@pravaah`), and therefore settles internally. */
export function isOwnVpa(raw: string, suffix = DEFAULT_VPA_SUFFIX): boolean {
  return parseVpa(raw)?.handle === suffix.toLowerCase()
}

export function isReservedLocalPart(localPart: string): boolean {
  return RESERVED_VPA_LOCALPARTS.has(localPart.toLowerCase())
}

/**
 * Mask a VPA for logs and error messages.
 *
 * `ra***i@pravaah`. A payment log is read by support staff and shipped to an
 * observability vendor, and a full VPA is a directly payable address — the one
 * piece of data in a transaction record that is immediately actionable by whoever
 * reads it. The handle is kept because knowing the PSP is often the whole point of
 * reading the log.
 */
export function maskVpa(raw: string): string {
  const parsed = parseVpa(raw)
  if (!parsed) return '***'
  const { localPart, handle } = parsed
  if (localPart.length <= 2) return `${localPart[0] ?? ''}*@${handle}`
  return `${localPart.slice(0, 2)}${'*'.repeat(
    Math.min(localPart.length - 3, 6),
  )}${localPart.slice(-1)}@${handle}`
}

/**
 * Propose VPA candidates from a seed (a verified name, or a Pravaah ID).
 *
 * Returns a LIST rather than one answer, so the caller can walk it until the
 * unique index accepts one — the only race-free way to allocate, since any
 * "is it free?" check is stale the moment it returns. Digits come from the seed
 * rather than a random source so allocation is deterministic and testable.
 */
export function vpaCandidates(
  seed: string,
  suffix = DEFAULT_VPA_SUFFIX,
): string[] {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 24)

  // A seed that normalises to nothing usable (an all-script name, an empty
  // string) must not produce `@pravaah` with an empty local part.
  const root = base.length >= 2 ? base : `pvh${hashSeed(seed) % 100_000}`

  const candidates = [root]
  for (let i = 1; i <= 8; i++) {
    candidates.push(`${root}${(hashSeed(`${seed}:${i}`) % 9_000) + 1_000}`)
  }

  return candidates
    .filter((localPart) => !isReservedLocalPart(localPart))
    .map((localPart) => `${localPart}@${suffix}`)
    .filter(isValidVpa)
}

/** FNV-1a. Deterministic and dependency-free; not used for anything secret. */
function hashSeed(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

// ── account handles ─────────────────────────────────────────────────────────
/**
 * The canonical handle for an account+IFSC beneficiary: `account|IFSC`.
 *
 * One string, because `Beneficiary.handle` is unique per user and that uniqueness
 * is what stops the same payee becoming two rows with two cooling periods. The
 * pipe cannot appear in either component, so the encoding is unambiguous.
 */
export function buildAccountHandle(
  accountNumber: string,
  ifsc: string,
): string {
  return `${accountNumber.trim()}|${ifsc.trim().toUpperCase()}`
}

export function parseAccountHandle(
  handle: string,
): { accountNumber: string; ifsc: string } | null {
  const parts = handle.split('|')
  if (parts.length !== 2) return null
  const [accountNumber, ifsc] = parts
  if (!accountNumber || !ifsc) return null
  return { accountNumber, ifsc }
}

/** `XXXXXX7890|HDFC0001234` — the only projection of an account we ever display. */
export function maskAccountHandle(handle: string): string {
  const parsed = parseAccountHandle(handle)
  if (!parsed) return '***'
  const { accountNumber, ifsc } = parsed
  return `${'X'.repeat(Math.max(accountNumber.length - 4, 0))}${accountNumber.slice(-4)}|${ifsc}`
}

/**
 * Mask any handle without the caller having to know which kind it is.
 *
 * Used by loggers and error paths, where getting this wrong means leaking a full
 * account number into a log line precisely when something has already gone wrong.
 */
export function maskHandle(handle: string): string {
  return handle.includes('@') ? maskVpa(handle) : maskAccountHandle(handle)
}
