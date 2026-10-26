import { z } from 'zod'

import { ScoreBandSchema } from '../../scoring/schemas/scoring-enums.schema'

/**
 * Predicates — the data-minimisation centre of M7.
 *
 * A lender rarely needs the number 782; it needs "is the band at least GOOD?".
 * A predicate lets it ask exactly that and receive a boolean.
 *
 * What makes this honest rather than a server-side filter: M3 mints the four
 * `score_at_least_*` threshold claims into EVERY credential, true or false, each
 * one issuer-signed and selectively disclosable. So every predicate below compiles
 * to at most two of those booleans — the holder discloses the booleans, never the
 * band or the score, and the partner evaluates an answer the issuer signed. Nothing
 * is "trust us, we looked at the number for you".
 *
 * Only predicates that compile that way are accepted. `score_value >= 700` does
 * not align with a band boundary, so it cannot be answered without disclosing the
 * value — and it is refused at request time rather than quietly downgraded to a
 * raw-value request the holder would not recognise.
 */
export const PREDICATE_OPS = ['GTE', 'GT', 'LTE', 'LT', 'EQ'] as const
export type PredicateOp = (typeof PREDICATE_OPS)[number]

export const PredicateOpSchema = z.enum(PREDICATE_OPS)

/** The claims a predicate may range over. Deliberately just one, for now. */
export const PREDICATE_CLAIMS = ['score_band'] as const
export type PredicateClaim = (typeof PREDICATE_CLAIMS)[number]

export const PredicateSpecSchema = z.object({
  claim: z.enum(PREDICATE_CLAIMS),
  op: PredicateOpSchema,
  value: ScoreBandSchema,
})
export type PredicateSpec = z.infer<typeof PredicateSpecSchema>

/**
 * The stable key a predicate result is reported under — `score_band:GTE:GOOD`.
 * Stable because a partner's code switches on it, and the consent receipt stores it.
 */
export function predicateKey(spec: PredicateSpec): string {
  return `${spec.claim}:${spec.op}:${spec.value}`
}
