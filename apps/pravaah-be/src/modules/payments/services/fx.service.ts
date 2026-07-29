import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { FX_QUOTE_TTL_MS, type QuoteRequestDto } from '@pravaah/schema'

import { ENV } from '@/constants/environment.constants'
import { httpJson } from '@/common/http/http-client'
import {
  RATE_SCALE,
  rateE8FromString,
  toMinor,
} from '@/modules/payments/money.util'
import { FALLBACK_MID_RATES } from '@/modules/payments/payments.config'
import { priceTransfer } from '@/modules/payments/pricing.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { Prisma, type FxQuote } from 'generated/prisma/client'

/**
 * FX quoting and rate locks.
 *
 * A quote is not a rate — it is a PRICED INTENT: the complete set of numbers the user
 * was shown, frozen server-side and single-use. Every transfer is submitted against
 * one, including domestic transfers where there is nothing to convert.
 *
 * That uniformity is the point. The alternative is the app rendering one total and the
 * server independently deriving another at submit time, from a fee table that may have
 * been reloaded in between — and the user being charged a figure they never agreed to.
 * The orchestrator therefore READS the breakdown back off the quote rather than
 * recomputing it; recomputation is the bug this design removes.
 *
 * Two safeguards make the lock real:
 *
 *  - **Short validity.** The window is the platform's own market exposure. 90 seconds
 *    is long enough to read a confirmation screen and short enough that the position
 *    stays small.
 *  - **Single use.** {@link consume} is a conditional update, so one favourable quote
 *    cannot fund an unlimited number of transfers.
 */
@Injectable()
export class FxService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FxService.name })
  }

  /**
   * Create a quote.
   *
   * The whole breakdown is computed once, by {@link priceTransfer}, and written
   * verbatim. Nothing downstream re-derives any of it.
   */
  async quote(userId: string, dto: QuoteRequestDto): Promise<FxQuote> {
    const { rateE8: midRateE8, source: rateSource } = await this.midRate(
      dto.sourceCurrency,
      dto.destCurrency,
    )

    const priced = priceTransfer({
      mode: dto.mode,
      amountMinor: toMinor(dto.amountMinor),
      sourceCurrency: dto.sourceCurrency,
      destCurrency: dto.destCurrency,
      midRateE8,
    })

    const quote = await this.prisma.fxQuote.create({
      data: {
        userId,
        sourceCurrency: priced.sourceCurrency,
        destCurrency: priced.destCurrency,
        midRateE8: priced.midRateE8,
        rateE8: priced.rateE8,
        spreadBps: priced.spreadBps,
        sourceAmount: priced.sourceAmount,
        destAmount: priced.destAmount,
        feeMinor: priced.feeMinor,
        taxMinor: priced.taxMinor,
        totalDebitMinor: priced.totalDebitMinor,
        rateSource,
        validUntil: new Date(Date.now() + FX_QUOTE_TTL_MS),
      },
    })

    this.logger.info(`[${this.quote.name}] Quote locked`, {
      userId,
      quoteId: quote.id,
      corridor: priced.corridor,
      rateSource,
    })
    return quote
  }

  /**
   * Fetch a quote that may still be acted on.
   *
   * Every failure mode is a distinct message, because they need distinct responses
   * from the app: expiry means "re-quote and show the new number", a currency mismatch
   * means the client has confused two flows, and an already-consumed quote means a
   * duplicate submit whose first attempt succeeded.
   */
  async requireLive(
    userId: string,
    quoteId: string,
    expected: { sourceCurrency?: string; destCurrency?: string } = {},
  ): Promise<FxQuote> {
    const quote = await this.prisma.fxQuote.findFirst({
      where: { id: quoteId, userId },
    })
    if (!quote)
      throw new NotFoundException('That price quote could not be found')

    if (
      (expected.sourceCurrency &&
        quote.sourceCurrency !== expected.sourceCurrency) ||
      (expected.destCurrency && quote.destCurrency !== expected.destCurrency)
    ) {
      throw new BadRequestException(
        'That price quote is for a different currency pair',
      )
    }
    if (quote.consumedAt) {
      throw new ConflictException(
        'That price quote has already been used. Request a new one.',
      )
    }
    if (quote.validUntil <= new Date()) {
      throw new BadRequestException(
        'That price has expired. Please refresh to see the current rate.',
      )
    }
    return quote
  }

  /**
   * Burn the quote. Atomic, and therefore the actual single-use guarantee.
   *
   * A `findFirst` check followed by an update has a window in which two concurrent
   * submits both see `consumedAt: null` and both proceed — one quote funding two
   * transfers at a rate that was only ever offered once. The conditional update closes
   * it: the loser gets zero rows and a 409.
   *
   * Called inside the transaction that creates the transfer, so a rolled-back transfer
   * gives the quote back.
   */
  async consume(
    client: Prisma.TransactionClient,
    quoteId: string,
  ): Promise<void> {
    const consumed = await client.fxQuote.updateMany({
      where: { id: quoteId, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    if (consumed.count === 0) {
      throw new ConflictException(
        'That price quote has already been used. Request a new one.',
      )
    }
  }

  /**
   * Confirm the total the user pressed matches the total the quote carries.
   *
   * A cross-check, not an instruction — the charge always comes from the quote. What
   * it catches is a client showing a stale confirmation screen: without it, the user
   * agrees to one figure and is silently charged the (correct, different) other.
   */
  assertExpectedTotal(quote: FxQuote, expectedTotalMinor: string): void {
    if (quote.totalDebitMinor !== toMinor(expectedTotalMinor)) {
      throw new ConflictException(
        'The amount shown has changed. Please review the new total before confirming.',
      )
    }
  }

  // ── rates ─────────────────────────────────────────────────────────────────
  /**
   * The market mid-rate.
   *
   * Returns the SOURCE of the rate alongside it, and that is deliberate: a quote
   * stamped `static` is honest about having used a configured fallback, so a receipt
   * never implies a market rate we did not fetch. A silent fallback is the version
   * that turns a missing API key into a misrepresentation.
   *
   * A same-currency pair is hard-coded to exactly 1. Asking a feed for `INR/INR`
   * invites a response like `1.0002`, and `priceTransfer` would (correctly) refuse it —
   * so the round trip is skipped rather than risked.
   */
  async midRate(
    sourceCurrency: string,
    destCurrency: string,
  ): Promise<{ rateE8: bigint; source: string }> {
    if (sourceCurrency === destCurrency) {
      return { rateE8: RATE_SCALE, source: 'identity' }
    }

    const live = await this.fetchLiveRate(sourceCurrency, destCurrency)
    if (live) return { rateE8: live, source: 'live' }

    const fallback = FALLBACK_MID_RATES[`${sourceCurrency}_${destCurrency}`]
    if (!fallback) {
      throw new BadRequestException(
        `We do not currently support ${sourceCurrency} → ${destCurrency}`,
      )
    }
    return { rateE8: rateE8FromString(fallback), source: 'static' }
  }

  /**
   * Ask the configured FX feed.
   *
   * Returns `null` rather than throwing on every failure path, because a rate feed
   * being down must not take payments down with it — the configured fallback is a
   * worse rate, not a broken one. The rate is read as a STRING and parsed by
   * {@link rateE8FromString}; taking it as a JSON number would put it through binary
   * floating point before we ever saw it, which is the one thing this module forbids.
   */
  private async fetchLiveRate(
    sourceCurrency: string,
    destCurrency: string,
  ): Promise<bigint | null> {
    const baseUrl = this.config.get<string>(ENV.PAYMENTS.FX_API_URL)
    if (!baseUrl) return null

    const apiKey = this.config.get<string>(ENV.PAYMENTS.FX_API_KEY)
    const result = await httpJson<{ rates?: Record<string, unknown> }>(
      {
        method: 'GET',
        url: `${baseUrl.replace(/\/+$/, '')}/latest`,
        params: { base: sourceCurrency, symbols: destCurrency },
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      },
      `fx_${sourceCurrency}_${destCurrency}`,
    )
    if (!result.ok) {
      this.logger.warn(
        `[${this.fetchLiveRate.name}] FX feed unavailable; using the configured fallback`,
        { sourceCurrency, destCurrency, reason: result.error.code },
      )
      return null
    }

    const raw = result.value.rates?.[destCurrency]
    if (raw === undefined || raw === null) return null

    /**
     * A number is accepted and stringified; an OBJECT is not.
     *
     * A feed returning JSON numbers is normal, and `String(61.425)` is exact for any value a
     * feed actually sends. But `String({ value: 61.425 })` is `"[object Object]"`, and a bare
     * coercion would send that into the rate parser — which would reject it, but only after
     * the type system had stopped being able to tell us the feed's shape had changed.
     */
    const text =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' && Number.isFinite(raw)
          ? String(raw)
          : null
    if (text === null) {
      this.logger.warn(
        `[${this.fetchLiveRate.name}] FX feed returned a non-scalar rate`,
        { sourceCurrency, destCurrency, kind: typeof raw },
      )
      return null
    }

    try {
      // The parse still refuses anything with more precision than the scale holds.
      return rateE8FromString(text)
    } catch (error) {
      this.logger.warn(
        `[${this.fetchLiveRate.name}] FX feed returned an unusable rate`,
        { sourceCurrency, destCurrency, raw: text, err: error },
      )
      return null
    }
  }

  /** Expire stale quotes. Housekeeping only — `requireLive` never trusts the flag. */
  async purgeExpired(olderThanMs = 24 * 60 * 60 * 1_000): Promise<number> {
    const result = await this.prisma.fxQuote.deleteMany({
      where: {
        validUntil: { lt: new Date(Date.now() - olderThanMs) },
        consumedAt: null,
        transactions: { none: {} },
      },
    })
    return result.count
  }
}
