import type { Result } from '@/common/result/result'

/**
 * Document extraction for claims.
 *
 * The interface is deliberately narrow — one call, one return shape — because the
 * whole point is that a real OCR vendor and the deterministic dev provider are
 * interchangeable. `DevOcrProvider` reads a JSON envelope, Google Vision reads
 * pixels, and `ClaimsService` cannot tell the difference: it receives fields, an
 * amount, a tamper score and a confidence, and applies the same two thresholds
 * either way.
 *
 * ## The two numbers that are not the same thing
 *
 * `tamperScore` and `confidence` are separate, and conflating them is the mistake
 * this interface exists to prevent:
 *
 *  - **`confidence`** is "how sure am I that I read this correctly?" A cracked
 *    phone camera in bad light scores low. The response is to ask for a better
 *    photo.
 *  - **`tamperScore`** is "how likely is it that this document was altered?"
 *    Inconsistent fonts, a re-encoded region, metadata that disagrees with the
 *    layout. The response is to route the claim to a human and never auto-pay it.
 *
 * A system that averaged the two would let a confidently-read forgery through, and
 * would accuse somebody with a blurry payslip of fraud. Both errors land on the
 * same person: a claimant who most needs the money.
 */
export const OCR = Symbol('OCR')

export interface OcrExtract {
  /**
   * The extracted fields, e.g. `{ billAmount: "12450.00", hospital: "…" }`.
   *
   * Strings, not parsed types. A bill's date format, currency symbol and
   * thousands separator are the vendor's problem to read and OURS to interpret —
   * a provider returning a parsed `Date` would be making a timezone decision on
   * our behalf about a claim's incident date.
   */
  fields: Record<string, string>

  /**
   * The document's own amount, in integer minor units, when one was found.
   *
   * Minor units at the provider boundary, so the float that a decimal bill total
   * arrives as is converted exactly once, in one place, by code that knows the
   * currency's exponent.
   */
  amountMinor?: bigint

  /** 0..1 forgery likelihood. At or above the block threshold → SUSPECT. */
  tamperScore: number

  /** 0..1 extraction confidence. Below the floor the doc is not auto-verified. */
  confidence: number

  /** Which provider produced this, recorded for the audit trail. */
  provider: string
}

export interface OcrProvider {
  readonly name: string

  isConfigured(): boolean

  /**
   * Extract from a document.
   *
   * `docType` is required and drives the extraction: a bill parser pointed at a
   * boarding pass returns confident nonsense, and a claim decided on confident
   * nonsense is worse than one with no documents at all.
   *
   * Returns a `Result` rather than throwing, because an unreadable document is an
   * ordinary outcome — the claimant photographed a receipt in a dark room — and
   * it should mark one document REJECTED, not fail the claim submission.
   */
  extract(
    file: Buffer,
    docType: string,
    currency: string,
  ): Promise<Result<OcrExtract>>
}
