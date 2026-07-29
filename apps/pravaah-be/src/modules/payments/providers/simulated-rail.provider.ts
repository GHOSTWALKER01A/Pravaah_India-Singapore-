import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto'

import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'
import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, type Result } from '@/common/result/result'

import type {
  CollectInput,
  CollectOutput,
  CreateMandateInput,
  CreateMandateOutput,
  ExecuteMandateInput,
  PaymentProvider,
  RailStatusOutput,
  RailWebhookEvent,
  RefundOutput,
  ResolveHandleInput,
  ResolveHandleOutput,
  SubmitPayoutInput,
  SubmitPayoutOutput,
} from '@/modules/payments/providers/payment.provider'

/*
 * `require-await` is off for this file, deliberately.
 *
 * Every method here implements a promise-returning `PaymentProvider` method with a body that
 * does no I/O — which is precisely what `async` is for. The alternative is wrapping several
 * dozen returns across branchy switch statements in `Promise.resolve(...)`, which would make a
 * simulator whose whole value is being READABLE against the real rail's behaviour considerably
 * harder to check.
 */
/* eslint-disable @typescript-eslint/require-await */

/**
 * The scripted outcomes, encoded into the rail reference itself.
 *
 *   S  settles immediately
 *   P  accepted, settles after a delay
 *   F  rejected outright
 *   T  never answers at all         → the saga must reach DEEMED
 *   L  reports FAILED, then SUCCESS → the money-losing late settlement
 */
const SIM_OUTCOME = {
  INSTANT_SUCCESS: 'S',
  PENDING_THEN_SUCCESS: 'P',
  FAIL: 'F',
  TIMEOUT: 'T',
  LATE_SUCCESS: 'L',
} as const

type SimOutcome = (typeof SIM_OUTCOME)[keyof typeof SIM_OUTCOME]

/** The failure codes the simulator draws from — all real NPCI codes. */
const SIM_FAILURE_CODES = ['Z9', 'ZA', 'U30', 'ZH', 'U53', 'XH'] as const

/**
 * A faithful UPI rail simulator.
 *
 * Not a stub that returns success. The point of a simulator in a payments module is to
 * produce the cases the real rail produces on a bad day — and specifically the one
 * that loses money: **a SUCCESS that arrives after we had already given up and marked
 * the transfer FAILED**. If that path is not reachable on demand, the reconciliation
 * logic that exists to survive it has never actually run.
 *
 * ## Why the outcome lives in the rail reference
 *
 * The obvious implementation keeps a `Map<railRef, state>` in memory. That has a defect
 * which is easy to miss and fatal in exactly the wrong moment: a process restart wipes
 * it, so every in-flight transfer's status call returns "unknown" forever. The saga
 * then correctly refuses to guess, parks everything as DEEMED, and a demo — or a
 * staging environment after a deploy — is full of stuck money with no way to resolve
 * it.
 *
 * So the reference IS the state: `SIM-<rail>-<outcome>-<settleAtMs>-<nonce>`. Status is
 * a pure function of the reference and the clock. It survives restarts, needs no
 * storage, and is reproducible — which also makes the nasty paths testable rather than
 * merely observable.
 *
 * ## What this is not
 *
 * The cross-border subclass simulates the **UPI↔PayNow linkage**, which is a bank rail
 * (DBS Singapore / Liquid Group) reached through a regulated PSP — not an API anyone
 * can sign up for. Production requires a PSP or sponsor-bank partnership (Nium,
 * Thunes, Wise Platform) under RBI/MAS licensing. Nothing here pretends otherwise, and
 * every reference it mints is visibly prefixed `SIM-`.
 */
export abstract class SimulatedRailProvider implements PaymentProvider {
  protected readonly logger: AppLogger

  constructor(
    protected readonly config: ConfigService,
    logger: AppLogger,
  ) {
    this.logger = logger.child({ context: this.constructor.name })
  }

  abstract readonly name: string
  /** The domestic rail supports pull (collect, AutoPay); the linkage does not. */
  protected abstract readonly supportsPull: boolean

  /** Always. A simulator with no credentials is the point. */
  isConfigured(): boolean {
    return true
  }

  // ── name resolution ───────────────────────────────────────────────────────
  /**
   * Resolve an address to the name its bank holds.
   *
   * Derived from the handle, so the same address always resolves to the same name —
   * a name that changed between the confirmation screen and the transfer would trip
   * the `confirmedRegisteredName` check and look like a bug in our own guard.
   *
   * Two reserved local parts make the unreachable paths demonstrable: anything
   * containing `invalid` or `unknown` comes back unreachable, which is how the
   * beneficiary-INVALID branch gets exercised without needing a real dead VPA.
   */
  resolveHandle(
    input: ResolveHandleInput,
  ): Promise<Result<ResolveHandleOutput>> {
    const handle = input.handle.toLowerCase()

    if (handle.includes('invalid') || handle.includes('unknown')) {
      return Promise.resolve(
        Ok({
          reachable: false,
          registeredName: null,
          reason: 'That UPI ID could not be found at the payee bank',
        }),
      )
    }
    if (handle.includes('dormant')) {
      return Promise.resolve(
        Ok({
          reachable: false,
          registeredName: null,
          reason: "The payee's account is inactive or dormant",
        }),
      )
    }

    return Promise.resolve(
      Ok({
        reachable: true,
        registeredName: derivedName(handle),
        bankName: derivedBank(handle),
      }),
    )
  }

  // ── payout ────────────────────────────────────────────────────────────────
  async submitPayout(
    input: SubmitPayoutInput,
  ): Promise<Result<SubmitPayoutOutput>> {
    const outcome = this.pickOutcome(input.idempotencyKey)
    const settleAt = Date.now() + this.settleDelayMs()
    const railRef = this.encodeRef(outcome, settleAt)

    this.logger.info(`[${this.submitPayout.name}] Simulated submit`, {
      transactionId: input.transactionId,
      outcome,
      railRef,
    })

    switch (outcome) {
      case SIM_OUTCOME.FAIL:
        /**
         * A rail REJECTION, not a transport error.
         *
         * Returned as `Ok` with a failure code rather than `Err`, and the distinction
         * matters: `Err` means we do not know whether the rail got the message, so the
         * reserve must be held. A code means it definitely refused, so the reserve can
         * be released immediately.
         */
        return Ok({
          railRef,
          status: 'SUBMITTED',
          railCode: pickFailureCode(railRef),
        })

      case SIM_OUTCOME.INSTANT_SUCCESS:
        return Ok({
          railRef,
          status: 'SUCCESS',
          utr: deriveUtr(railRef),
          railCode: '00',
        })

      default:
        // PENDING, TIMEOUT and LATE_SUCCESS all look identical at submit time — which
        // is precisely the situation the saga has to be safe in.
        return Ok({ railRef, status: 'PENDING' })
    }
  }

  /**
   * What the rail says now. A pure function of the reference and the clock.
   *
   * The LATE_SUCCESS branch is the showpiece: it reports `FAILED` with a timeout code
   * for the whole settlement window, so the saga does the honest thing and marks the
   * transfer failed — and then flips to `SUCCESS`. Reconciliation must notice and
   * correct itself, or the beneficiary keeps a payment funded out of our own pocket.
   */
  async status(railRef: string): Promise<Result<RailStatusOutput>> {
    const decoded = this.decodeRef(railRef)
    if (!decoded) {
      /**
       * A reference we cannot read.
       *
       * PENDING, never FAILED. "I do not recognise this" is not evidence that nothing
       * happened, and answering FAILED here would have the reconciler release a reserve
       * for a payment that may well have settled.
       */
      return Ok({ status: 'PENDING' })
    }

    const { outcome, settleAtMs } = decoded
    const settled = Date.now() >= settleAtMs

    switch (outcome) {
      case SIM_OUTCOME.INSTANT_SUCCESS:
        return Ok({
          status: 'SUCCESS',
          railCode: '00',
          utr: deriveUtr(railRef),
        })

      case SIM_OUTCOME.FAIL:
        return Ok({ status: 'FAILED', railCode: pickFailureCode(railRef) })

      case SIM_OUTCOME.TIMEOUT:
        // Never resolves. The status-check budget runs out and the saga parks it as
        // DEEMED with the funds still in suspense.
        return Ok({ status: 'PENDING', railCode: 'U88' })

      case SIM_OUTCOME.LATE_SUCCESS:
        return settled
          ? Ok({
              status: 'SUCCESS',
              railCode: '00',
              utr: deriveUtr(railRef),
              settledAt: new Date(settleAtMs),
            })
          : Ok({ status: 'FAILED', railCode: 'U54' })

      case SIM_OUTCOME.PENDING_THEN_SUCCESS:
      default:
        return settled
          ? Ok({
              status: 'SUCCESS',
              railCode: '00',
              utr: deriveUtr(railRef),
              settledAt: new Date(settleAtMs),
            })
          : Ok({ status: 'PENDING' })
    }
  }

  /**
   * Refunds always succeed in the simulator, and the input is deliberately unused.
   *
   * The interesting refund cases are NOT rail-side failures — they are the ordering rules in
   * `ReversalService`: the rail leg must go before the ledger, and a PENDING refund must not
   * credit the wallet. Those are exercised by driving the reversal, not by making this method
   * fail. A rail-declined refund is reachable through the mock rail's `refund` webhook.
   */
  refund(): Promise<Result<RefundOutput>> {
    return Promise.resolve(
      Ok({
        railRef: this.encodeRef(SIM_OUTCOME.INSTANT_SUCCESS, Date.now()),
        status: 'SUCCESS',
      }),
    )
  }

  // ── collect + mandate (domestic only) ─────────────────────────────────────
  async createCollect(input: CollectInput): Promise<Result<CollectOutput>> {
    if (!this.supportsPull) {
      // A property of the linkage, not a gap in the simulator: UPI↔PayNow is
      // payer-initiated only, so there is no cross-border collect to raise.
      return Err(
        new KycError(
          KycErrorCode.INVALID_INPUT,
          'The cross-border linkage is payer-initiated — money cannot be requested over it',
          false,
        ),
      )
    }
    return Ok({
      railRef: this.encodeRef(
        SIM_OUTCOME.PENDING_THEN_SUCCESS,
        input.expiresAt.getTime(),
      ),
      status: 'PENDING',
    })
  }

  async createMandate(
    input: CreateMandateInput,
  ): Promise<Result<CreateMandateOutput>> {
    if (!this.supportsPull) {
      return Err(
        new KycError(
          KycErrorCode.INVALID_INPUT,
          'AutoPay is not available on the cross-border linkage',
          false,
        ),
      )
    }
    const railRef = this.encodeRef(SIM_OUTCOME.PENDING_THEN_SUCCESS, Date.now())
    return Ok({
      railRef,
      // The UPI Mandate Number is only assigned once the PAYER approves in their own
      // app, so it is deliberately absent here.
      status: 'PENDING',
      approvalUrl: `${this.publicUrl()}/api/v1/mock/upi/mandate/${input.mandateRef}`,
    })
  }

  async executeMandate(
    input: ExecuteMandateInput,
  ): Promise<Result<SubmitPayoutOutput>> {
    if (!this.supportsPull) {
      return Err(
        new KycError(
          KycErrorCode.INVALID_INPUT,
          'AutoPay is not available on the cross-border linkage',
          false,
        ),
      )
    }
    const outcome = this.pickOutcome(input.idempotencyKey)
    const railRef = this.encodeRef(outcome, Date.now() + this.settleDelayMs())
    return outcome === SIM_OUTCOME.FAIL
      ? Ok({ railRef, status: 'SUBMITTED', railCode: pickFailureCode(railRef) })
      : Ok({ railRef, status: 'PENDING' })
  }

  revokeMandate(): Promise<Result<void>> {
    return Promise.resolve(Ok(undefined))
  }

  // ── webhooks ──────────────────────────────────────────────────────────────
  /**
   * Verify a simulated webhook.
   *
   * The simulator signs its callbacks with the same HMAC scheme a real provider uses,
   * rather than returning `true`. A verification path that is bypassed in development
   * is a verification path nobody has run, and it will be first exercised in
   * production against a real attacker.
   */
  verifyWebhook(headers: Record<string, unknown>, rawBody: string): boolean {
    const secret = this.webhookSecret()
    const provided = asText(headers['x-rail-signature']) ?? ''
    if (!provided) return false

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /** Sign a body the way this provider expects. Used by the mock rail controller. */
  signWebhook(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret())
      .update(rawBody)
      .digest('hex')
  }

  parseWebhook(body: unknown): RailWebhookEvent | null {
    if (!body || typeof body !== 'object') return null
    const payload = body as Record<string, unknown>

    const railRef = asString(payload.railRef)
    const status = asString(payload.status)?.toUpperCase()
    if (!status || !['SUCCESS', 'FAILED', 'PENDING'].includes(status))
      return null

    return {
      // No event id means we cannot dedupe, so one is derived from the fields that
      // identify the event. A webhook we cannot dedupe is a webhook that can settle
      // a transaction twice.
      eventId:
        asString(payload.eventId) ??
        createHash('sha256')
          .update(`${railRef ?? ''}|${status}|${asString(payload.utr) ?? ''}`)
          .digest('hex')
          .slice(0, 32),
      kind: (asString(payload.kind) as RailWebhookEvent['kind']) ?? 'payment',
      railRef: railRef ?? undefined,
      utr: asString(payload.utr) ?? undefined,
      status: status as RailWebhookEvent['status'],
      railCode: asString(payload.railCode) ?? undefined,
      amountMinor:
        payload.amountMinor === undefined || payload.amountMinor === null
          ? undefined
          : BigInt(asText(payload.amountMinor) ?? '0'),
      currency: asString(payload.currency) ?? undefined,
      objectRef: asString(payload.objectRef) ?? undefined,
    }
  }

  // ── scripting ─────────────────────────────────────────────────────────────
  /**
   * Choose an outcome.
   *
   * `PAYMENTS_SIM_FORCE_OUTCOME` pins it, which is how a demo walks a judge through
   * the late-settlement recovery on the first try instead of retrying until chance
   * cooperates. Otherwise the configured percentages apply, seeded from the
   * idempotency key so a RETRY OF THE SAME REQUEST gets the same outcome — a rail that
   * answered differently to an identical retry would be a rail no idempotency scheme
   * could work against.
   */
  protected pickOutcome(idempotencyKey: string): SimOutcome {
    const forced = this.config
      .get<string>(ENV.PAYMENTS.SIM.FORCE_OUTCOME)
      ?.trim()
      .toLowerCase()

    switch (forced) {
      case 'success':
        return SIM_OUTCOME.INSTANT_SUCCESS
      case 'pending':
        return SIM_OUTCOME.PENDING_THEN_SUCCESS
      case 'fail':
        return SIM_OUTCOME.FAIL
      case 'timeout':
        return SIM_OUTCOME.TIMEOUT
      case 'late-success':
        return SIM_OUTCOME.LATE_SUCCESS
      default:
        break
    }

    const roll = seededPercent(`${this.name}:${idempotencyKey}`)
    const failAt = this.percent(ENV.PAYMENTS.SIM.FAIL_PERCENT, 8)
    const timeoutAt = failAt + this.percent(ENV.PAYMENTS.SIM.TIMEOUT_PERCENT, 4)

    if (roll < failAt) return SIM_OUTCOME.FAIL
    if (roll < timeoutAt) return SIM_OUTCOME.TIMEOUT
    return SIM_OUTCOME.PENDING_THEN_SUCCESS
  }

  /** `SIM-<rail>-<outcome>-<settleAtMs>-<nonce>`. The reference IS the state. */
  protected encodeRef(outcome: SimOutcome, settleAtMs: number): string {
    return `SIM-${this.refTag()}-${outcome}-${settleAtMs}-${randomUUID().slice(0, 8)}`
  }

  protected decodeRef(
    railRef: string,
  ): { outcome: SimOutcome; settleAtMs: number } | null {
    const match = /^SIM-[A-Z]+-([SPFTL])-(\d+)-[0-9a-f]{8}$/.exec(railRef)
    if (!match?.[1] || !match[2]) return null
    return {
      outcome: match[1] as SimOutcome,
      settleAtMs: Number(match[2]),
    }
  }

  protected abstract refTag(): string

  protected settleDelayMs(): number {
    const raw = Number(
      this.config.get<string>(ENV.PAYMENTS.SIM.SETTLE_DELAY_MS),
    )
    return Number.isFinite(raw) && raw >= 0 ? raw : 8_000
  }

  private percent(key: string, fallback: number): number {
    const raw = Number(this.config.get<string>(key))
    return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : fallback
  }

  private webhookSecret(): string {
    return (
      this.config.get<string>(
        `${ENV.PAYMENTS.WEBHOOK_SECRET_PREFIX}${this.name.toUpperCase().replace(/-/g, '_')}`,
      ) ??
      this.config.get<string>(ENV.WEBHOOK.HMAC_SECRET) ??
      'pravaah-sim-webhook-secret'
    )
  }

  private publicUrl(): string {
    return (
      this.config.get<string>(ENV.API.PUBLIC_URL)?.replace(/\/+$/, '') ??
      'http://localhost:8000'
    )
  }
}

/** Domestic NPCI UPI. Supports collect and AutoPay. */
@Injectable()
export class UpiSimProvider extends SimulatedRailProvider {
  readonly name = 'upi-sim'
  protected readonly supportsPull = true

  constructor(config: ConfigService, @Inject(APP_LOGGER) logger: AppLogger) {
    super(config, logger)
  }

  protected refTag(): string {
    return 'UPI'
  }
}

/**
 * The India↔Singapore UPI↔PayNow linkage.
 *
 * Payer-initiated only, so collect and AutoPay are unavailable — and refused with a
 * reason rather than silently accepted. Settlement is slower than domestic because a
 * cross-border leg genuinely is: two banking systems and a correspondent in between.
 */
@Injectable()
export class UpiPayNowSimProvider extends SimulatedRailProvider {
  readonly name = 'upi-paynow-sim'
  protected readonly supportsPull = false

  constructor(config: ConfigService, @Inject(APP_LOGGER) logger: AppLogger) {
    super(config, logger)
  }

  protected refTag(): string {
    return 'PAYNOW'
  }

  protected settleDelayMs(): number {
    return super.settleDelayMs() * 2
  }
}

// ── deterministic derivations ───────────────────────────────────────────────
/** A stable 0–99 from a string. Deterministic, so a retry replays its outcome. */
function seededPercent(seed: string): number {
  const digest = createHash('sha256').update(seed).digest()
  return (digest.readUInt16BE(0) ?? 0) % 100
}

function pickFailureCode(railRef: string): string {
  const digest = createHash('sha256').update(railRef).digest()
  const index = (digest[0] ?? 0) % SIM_FAILURE_CODES.length
  return SIM_FAILURE_CODES[index] ?? 'U30'
}

/**
 * A plausible bank-registered name for a handle.
 *
 * Upper-cased, because that is how core banking systems return names — and the
 * name-match logic downstream has to cope with it. A simulator returning tidy
 * title-case would hide a real normalisation problem until production.
 */
function derivedName(handle: string): string {
  const local = handle.split('@')[0] ?? handle
  const words = local
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !/^\d+$/.test(word))

  if (words.length === 0) {
    // A numeric VPA (`9876543210@ybl`) is common and has no name in it.
    const digest = createHash('sha256').update(handle).digest()
    const surnames = ['KUMAR', 'SHARMA', 'IYER', 'TAN', 'LIM', 'DAS']
    return `RAVI ${surnames[(digest[1] ?? 0) % surnames.length]}`
  }
  return words.join(' ').toUpperCase()
}

function derivedBank(handle: string): string {
  const suffix = handle.split('@')[1] ?? ''
  const banks: Record<string, string> = {
    pravaah: 'Pravaah Payments',
    ybl: 'Yes Bank',
    okhdfcbank: 'HDFC Bank',
    oksbi: 'State Bank of India',
    paytm: 'Paytm Payments Bank',
    dbs: 'DBS Bank Singapore',
  }
  return banks[suffix] ?? 'Partner Bank'
}

/**
 * A UTR-shaped reference: 12 digits, as NPCI issues.
 *
 * Derived from the rail reference so it is stable across status calls. A UTR that
 * changed between two reads is a UTR the customer cannot quote to their bank.
 */
function deriveUtr(railRef: string): string {
  const digest = createHash('sha256').update(`utr:${railRef}`).digest('hex')
  return BigInt(`0x${digest.slice(0, 16)}`)
    .toString()
    .slice(0, 12)
    .padStart(12, '1')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Coerce a PRIMITIVE to text.
 *
 * `undefined` for an object or array rather than `"[object Object]"`, which is what a bare
 * `String(value)` produces — and which would then flow into a `BigInt()` parse or a
 * signature comparison as a plausible-looking string.
 */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return String(value)
  return undefined
}
