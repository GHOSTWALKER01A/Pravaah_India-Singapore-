import { createHash } from 'crypto'

import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, type Result } from '@/common/result/result'
import { majorToMinor } from '@/modules/payments/money.util'

import type {
  OcrExtract,
  OcrProvider,
} from '@/modules/insurance/providers/ocr.provider'

/**
 * Deterministic document extraction for development, CI and the demo.
 *
 * It accepts a JSON envelope instead of reading pixels:
 *
 * ```json
 * { "amount": "12450.00",
 *   "fields": { "hospital": "Apollo, Chennai", "date": "2026-07-14" },
 *   "tamper": false, "blurry": false }
 * ```
 *
 * The CONTRACT is identical to a real vendor's — fields, `amountMinor`,
 * `tamperScore`, `confidence` — so `ClaimsService` applies the same two thresholds
 * whether Google Vision or this file answered. Swapping to a real provider changes
 * one registry entry.
 *
 * ## Why a JSON envelope rather than a bundled image
 *
 * Three reasons, and the third is the one that matters:
 *
 *  1. **Determinism.** A test that asserts "a forged bill is gated to review" must
 *     not depend on a vision model's confidence drifting between versions.
 *  2. **No network in CI.** The claims pipeline is testable offline.
 *  3. **The tamper case is DEMONSTRABLE ON DEMAND.** `{"tamper": true}` produces a
 *     0.92 forgery score, so the most important behaviour in the module — a forged
 *     document being hard-routed to a human instead of auto-paid — can be shown in
 *     front of a judge in one request. A real vision provider gives no reliable way
 *     to produce a document it will call forged.
 *
 * ## Why an unreadable document is an error, not a zero score
 *
 * `extract` returns `Err` when the payload will not parse, and it deliberately does
 * NOT return `{ tamperScore: 0, confidence: 0 }`. A zero tamper score means "I
 * looked and found no sign of forgery"; a parse failure means "I could not look at
 * all". Reporting the second as the first would let an unreadable file satisfy the
 * no-tamper half of the auto-approve condition.
 */
@Injectable()
export class DevOcrProvider implements OcrProvider {
  readonly name = 'dev-ocr'

  private readonly logger: AppLogger

  constructor(@Inject(APP_LOGGER) logger: AppLogger) {
    this.logger = logger.child({ context: DevOcrProvider.name })
  }

  isConfigured(): boolean {
    return true
  }

  extract(
    file: Buffer,
    docType: string,
    currency: string,
  ): Promise<Result<OcrExtract>> {
    if (file.length === 0) {
      return Promise.resolve(
        Err(
          new KycError(
            KycErrorCode.INVALID_INPUT,
            'The uploaded document was empty',
            false,
          ),
        ),
      )
    }

    let parsed: Record<string, unknown>
    try {
      const decoded: unknown = JSON.parse(file.toString('utf8'))
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('not an object')
      }
      parsed = decoded as Record<string, unknown>
    } catch {
      this.logger.warn(
        `[${this.extract.name}] Unreadable document — the dev provider expects a JSON envelope`,
        { docType, bytes: file.length },
      )
      return Promise.resolve(
        Err(
          new KycError(
            KycErrorCode.INVALID_INPUT,
            'This document could not be read. Please upload a clearer copy.',
            // Retryable: the claimant re-uploading a better file is exactly the
            // recovery, so this must not mark the claim terminally unverifiable.
            true,
          ),
        ),
      )
    }

    const amountMinor = this.readAmount(parsed.amount, currency)
    if (parsed.amount !== undefined && amountMinor === undefined) {
      /**
       * An amount was present and unparseable.
       *
       * Refused rather than dropped. Silently discarding it would make the
       * extracted-versus-claimed mismatch check pass by having nothing to compare,
       * which turns a malformed bill into a claim with one fewer fraud signal.
       */
      return Promise.resolve(
        Err(
          new KycError(
            KycErrorCode.INVALID_INPUT,
            'The amount on this document could not be read',
            true,
          ),
        ),
      )
    }

    const tamperScore = parsed.tamper === true ? 0.92 : 0.05
    const confidence = parsed.blurry === true ? 0.4 : 0.95

    if (tamperScore > 0.5) {
      this.logger.warn(
        `[${this.extract.name}] Document scored as likely altered`,
        { docType, tamperScore, sha256: this.fingerprint(file) },
      )
    }

    return Promise.resolve(
      Ok({
        fields: this.readFields(parsed.fields),
        amountMinor,
        tamperScore,
        confidence,
        provider: this.name,
      }),
    )
  }

  /**
   * A major-unit decimal string → minor units, through M4's parser.
   *
   * `majorToMinor` rather than `Math.round(Number(x) * 100)`, because
   * `Math.round(parseFloat("1.005") * 100)` is `100`, not `101` — and this value is
   * compared against a claimed amount to decide whether somebody is asking for more
   * than their evidence supports. It also rejects more decimal places than the
   * currency has, instead of guessing at `am=100.999`.
   */
  private readAmount(value: unknown, currency: string): bigint | undefined {
    if (value === undefined || value === null) return undefined

    /**
     * Only a number or a string is an amount.
     *
     * An object or an array is NOT stringified into `"[object Object]"` and then
     * handed to the parser: `majorToMinor` would reject it, the caller would read
     * `undefined` as "no amount was present", and a malformed document would
     * silently lose its extracted-versus-claimed mismatch signal. Returning
     * `undefined` here reaches the same rejection through the caller's explicit
     * "an amount was present and unparseable" branch.
     */
    if (typeof value !== 'number' && typeof value !== 'string') {
      return undefined
    }

    const text = typeof value === 'number' ? value.toFixed(2) : value
    try {
      return majorToMinor(text.trim(), currency)
    } catch {
      return undefined
    }
  }

  /** Coerce the fields bag to `Record<string, string>`. Non-strings are dropped. */
  private readFields(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [key, member] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof member === 'string') out[key] = member
      else if (typeof member === 'number' || typeof member === 'boolean') {
        out[key] = String(member)
      }
    }
    return out
  }

  /** A content fingerprint for the log line. The bytes themselves are never logged. */
  private fingerprint(file: Buffer): string {
    return createHash('sha256').update(file).digest('hex').slice(0, 16)
  }
}
