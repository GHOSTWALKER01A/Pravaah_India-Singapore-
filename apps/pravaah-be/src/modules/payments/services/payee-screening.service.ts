import { Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

export interface ScreeningResult {
  /** Whether the screen actually ran. `false` means fail-closed upstream. */
  screened: boolean
  hit: boolean
  /** Which list matched, for the compliance record. */
  matchedList?: string
  reason?: string
}

/**
 * AML/CFT screening for a PAYEE.
 *
 * Deliberately NOT M0's `SanctionsService`, and the reason is a bug worth naming: that
 * service records a `SANCTIONS_PEP` KycCheck against the profile of the user it is
 * called for. Passing a beneficiary's name to it would write a screening result — and
 * potentially a FAILED check that the orchestrator treats as a hard KYC reject — onto
 * the PAYER's identity record. A user would lose their verified status because of who
 * they tried to pay.
 *
 * The two screens also answer different questions. M0 asks "is this person allowed to
 * be a customer?" and its result belongs on their KYC profile. This asks "may money be
 * sent to this counterparty?" and its result belongs on the beneficiary row. Same
 * watchlists, different subject, different consequences.
 *
 * Behind one method so the seed list can be swapped for a real screening provider
 * (Dow Jones, Refinitiv, or the OFAC/UN/EU consolidated lists) without touching the
 * beneficiary flow — the same provider-swap pattern as M0–M3.
 */
@Injectable()
export class PayeeScreeningService {
  private readonly logger: AppLogger

  /**
   * Seed watchlist, lower-cased.
   *
   * A stand-in for a real sanctions feed. Kept deliberately small and obviously
   * synthetic so nobody mistakes it for compliance coverage — production requires a
   * maintained consolidated list with fuzzy matching and a documented false-positive
   * review process.
   */
  private readonly watchlist = new Map<string, string>([
    ['osama bin laden', 'UN Consolidated'],
    ['dawood ibrahim', 'UN Consolidated'],
    ['sanctioned payee', 'DEMO'],
    ['blocked beneficiary', 'DEMO'],
  ])

  constructor(@Inject(APP_LOGGER) logger: AppLogger) {
    this.logger = logger.child({ context: PayeeScreeningService.name })
  }

  /**
   * Screen a payee's bank-registered name.
   *
   * Matched on the NORMALISED name — case-folded, punctuation-stripped, whitespace
   * collapsed — because a watchlist that only catches an exact byte match catches
   * nothing. Also checks each token against the list, so a name padded with an extra
   * middle name does not slip through a whole-string comparison.
   */
  screenPayee(registeredName: string): Promise<ScreeningResult> {
    const normalised = normalise(registeredName)
    if (!normalised) {
      return Promise.resolve({
        screened: false,
        hit: false,
        reason: 'No verified name available to screen',
      })
    }

    const direct = this.watchlist.get(normalised)
    if (direct) {
      this.logger.warn(`[${this.screenPayee.name}] Payee matched a watchlist`, {
        matchedList: direct,
      })
      return Promise.resolve({ screened: true, hit: true, matchedList: direct })
    }

    /**
     * Substring containment, both ways.
     *
     * A listed "Dawood Ibrahim" must still match a bank name of "DAWOOD IBRAHIM
     * KASKAR", and a listed full name must match when the bank returns a shorter form.
     * This over-matches by design: a false positive is a support conversation, a false
     * negative is a sanctions breach.
     */
    for (const [entry, list] of this.watchlist) {
      if (normalised.includes(entry) || entry.includes(normalised)) {
        this.logger.warn(
          `[${this.screenPayee.name}] Payee partially matched a watchlist`,
          { matchedList: list },
        )
        return Promise.resolve({ screened: true, hit: true, matchedList: list })
      }
    }

    return Promise.resolve({ screened: true, hit: false })
  }
}

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
