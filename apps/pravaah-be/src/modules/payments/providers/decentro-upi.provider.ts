import { createHmac, timingSafeEqual } from 'crypto'

import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import {
  DECENTRO_TRANSFER_TYPE,
  DECENTRO_UPI_HEADERS,
  DECENTRO_UPI_PATHS,
  DECENTRO_UPI_STATUS,
  DECENTRO_UPI_SUCCESS_CODE,
  DECENTRO_WEBHOOK_SIGNATURE_HEADER,
} from '@/config/decentro-upi.config'
import { ENV } from '@/constants/environment.constants'
import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { httpJson } from '@/common/http/http-client'
import { Err, Ok, type Result } from '@/common/result/result'
import { fromMinor, majorToMinor } from '@/modules/payments/money.util'
import { parseAccountHandle } from '@/modules/payments/vpa.util'

import type {
  CollectInput,
  CollectOutput,
  CreateMandateInput,
  CreateMandateOutput,
  ExecuteMandateInput,
  PaymentProvider,
  RailStatusOutput,
  RailWebhookEvent,
  RefundInput,
  RefundOutput,
  ResolveHandleInput,
  ResolveHandleOutput,
  SubmitPayoutInput,
  SubmitPayoutOutput,
} from '@/modules/payments/providers/payment.provider'

import { BeneficiaryHandleType } from 'generated/prisma/client'

/**
 * LIVE domestic UPI over Decentro.
 *
 * Every vendor literal lives in `decentro-upi.config.ts`; this class owns request
 * shaping, response normalisation and error mapping, and nothing else.
 *
 * Three things it does that a straightforward HTTP wrapper would not, each of which is
 * load-bearing:
 *
 *  1. **Amounts convert to major units exactly once, on the way out.** Decentro's API
 *     speaks rupees with decimals; we hold paise as integers. That conversion happens
 *     here via `fromMinor`, and the reverse via `majorToMinor` — never through
 *     `parseFloat`, which loses a paisa on values users can trivially produce.
 *  2. **The idempotency key goes to the rail as well as into our database.** Our own
 *     guard stops a duplicate transaction row. Only this header stops a duplicate
 *     PAYMENT when our first request timed out after Decentro had accepted it.
 *  3. **An unrecognised status is not a failure.** It maps to PENDING here and to
 *     DEEMED downstream. A vendor adding a status string must never cause us to refund
 *     senders whose money actually moved.
 */
@Injectable()
export class DecentroUpiProvider implements PaymentProvider {
  readonly name = 'decentro'
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DecentroUpiProvider.name })
  }

  /**
   * Whether the credentials are present.
   *
   * Checked at wiring time rather than on first call. A live provider selected without
   * its secrets 401s on every request, which is indistinguishable from a rail outage —
   * and an operator will spend the incident debugging Decentro instead of their env
   * file.
   */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>(ENV.DECENTRO.BASE_URL) &&
      this.config.get<string>(ENV.DECENTRO.CLIENT_ID) &&
      this.config.get<string>(ENV.DECENTRO.CLIENT_SECRET),
    )
  }

  // ── name resolution ───────────────────────────────────────────────────────
  async resolveHandle(
    input: ResolveHandleInput,
  ): Promise<Result<ResolveHandleOutput>> {
    return input.handleType === BeneficiaryHandleType.ACCOUNT_IFSC
      ? this.pennyDrop(input)
      : this.validateVpa(input)
  }

  private async validateVpa(
    input: ResolveHandleInput,
  ): Promise<Result<ResolveHandleOutput>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.VPA_VALIDATE}`,
        headers: this.headers(),
        data: {
          reference_id: `vpa_${input.traceId}`,
          upi_id: input.handle,
          // Recorded on Decentro's side; a name lookup is a lookup of somebody's
          // banking details and needs a stated purpose.
          purpose: 'Beneficiary name verification',
        },
      },
      input.traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    const reachable =
      res.value.responseCode === DECENTRO_UPI_SUCCESS_CODE &&
      isTruthyFlag(data.vpaValid ?? data.valid ?? data.status)

    if (!reachable) {
      /**
       * `Ok`, not `Err`.
       *
       * "This address does not exist" is a successful lookup with a negative answer,
       * and the beneficiary must be recorded INVALID so the user is told why. An `Err`
       * would read as "we could not check", which is a retry, not a verdict.
       */
      return Ok({
        reachable: false,
        registeredName: null,
        reason:
          asString(data.message) ??
          'That UPI ID could not be found at the payee bank',
      })
    }

    return Ok({
      reachable: true,
      registeredName:
        asString(data.name) ??
        asString(data.customerName) ??
        asString(data.registeredName) ??
        null,
      bankName: asString(data.bankName) ?? undefined,
    })
  }

  /**
   * Penny-drop for an account+IFSC beneficiary.
   *
   * The same Decentro endpoint M0 uses for KYC bank verification, called here for a
   * different purpose: not "is this the user's account" but "what does this account's
   * bank call its holder". The answer is what the payer confirms before paying.
   */
  private async pennyDrop(
    input: ResolveHandleInput,
  ): Promise<Result<ResolveHandleOutput>> {
    const parsed = parseAccountHandle(input.handle)
    if (!parsed) {
      return Err(
        new KycError(
          KycErrorCode.INVALID_INPUT,
          'Account handle is malformed',
          false,
        ),
      )
    }

    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.ACCOUNT_VERIFY}`,
        headers: this.headers(),
        data: {
          reference_id: `bene_${input.traceId}`,
          account_number: parsed.accountNumber,
          ifsc: parsed.ifsc,
          consent: true,
          purpose: 'Beneficiary name verification',
        },
      },
      input.traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    const verified =
      res.value.responseCode === DECENTRO_UPI_SUCCESS_CODE &&
      (asText(data.accountStatus) ?? '').toUpperCase() === 'VALID'

    if (!verified) {
      return Ok({
        reachable: false,
        registeredName: null,
        reason: asString(data.message) ?? 'That account could not be verified',
      })
    }
    return Ok({
      reachable: true,
      registeredName:
        asString(data.beneficiaryName) ?? asString(data.nameAtBank) ?? null,
      bankName: asString(data.bankName) ?? undefined,
    })
  }

  // ── payout ────────────────────────────────────────────────────────────────
  async submitPayout(
    input: SubmitPayoutInput,
  ): Promise<Result<SubmitPayoutOutput>> {
    const account =
      input.payeeHandleType === BeneficiaryHandleType.ACCOUNT_IFSC
        ? parseAccountHandle(input.payeeHandle)
        : null

    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.PAYOUT}`,
        headers: this.headers(input.idempotencyKey),
        data: {
          reference_id: input.transactionId,
          // Major units with decimals — Decentro's contract. Derived from our integer
          // paise exactly once, here.
          amount: fromMinor(input.amountMinor, input.currency),
          currency: input.currency,
          purpose_message: input.narration ?? input.purposeCode,
          transfer_type: account
            ? DECENTRO_TRANSFER_TYPE.IMPS
            : DECENTRO_TRANSFER_TYPE.UPI,
          ...(account
            ? {
                beneficiary_account_number: account.accountNumber,
                beneficiary_ifsc: account.ifsc,
              }
            : { beneficiary_upi_id: input.payeeHandle }),
          ...(input.payeeName ? { beneficiary_name: input.payeeName } : {}),
          ...(input.mcc ? { mcc: input.mcc } : {}),
        },
      },
      input.traceId,
    )
    if (!res.ok) {
      /**
       * A transport failure, deliberately propagated as `Err`.
       *
       * We do not know whether Decentro received the request, so the caller must HOLD
       * the reserve rather than release it. Converting this into a FAILED payment would
       * refund a sender whose payment may be settling right now.
       */
      return res
    }

    const data = res.value.data ?? {}
    const railRef =
      asString(res.value.decentroTxnId) ??
      asString(data.decentroTxnId) ??
      asString(data.transactionId)

    if (!railRef) {
      /**
       * Accepted, apparently, but with no reference to track it by.
       *
       * Retryable rather than failed: an untrackable payment is the worst outcome
       * available — we could neither settle it nor prove it did not happen — so this
       * stays unresolved and the reconciler's statement sweep is what finds it.
       */
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Rail accepted the payment but returned no reference',
          true,
          res.value,
        ),
      )
    }

    return Ok({
      railRef,
      utr: asString(data.utr) ?? asString(data.rrn) ?? undefined,
      status: this.mapSubmitStatus(data.transactionStatus ?? data.status),
      railCode: asString(data.npciResponseCode) ?? asString(data.responseCode),
    })
  }

  async status(
    railRef: string,
    traceId: string,
  ): Promise<Result<RailStatusOutput>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'GET',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.TRANSACTION_STATUS}`,
        headers: this.headers(),
        params: { decentro_txn_id: railRef },
      },
      traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    return Ok({
      status: this.mapStatus(data.transactionStatus ?? data.status),
      railCode: asString(data.npciResponseCode) ?? asString(data.responseCode),
      utr: asString(data.utr) ?? asString(data.rrn) ?? undefined,
      amountMinor: this.parseAmount(
        data.amount,
        asString(data.currency) ?? 'INR',
      ),
    })
  }

  async refund(input: RefundInput): Promise<Result<RefundOutput>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.REFUND}`,
        headers: this.headers(input.idempotencyKey),
        data: {
          reference_id: input.idempotencyKey,
          decentro_txn_id: input.originalRailRef,
          amount: fromMinor(input.amountMinor, input.currency),
          reason: input.reason,
        },
      },
      input.traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    const railRef =
      asString(res.value.decentroTxnId) ?? asString(data.decentroTxnId)
    if (!railRef) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Refund accepted with no reference',
          true,
          res.value,
        ),
      )
    }
    return Ok({ railRef, status: this.mapSubmitStatus(data.status) })
  }

  // ── collect ───────────────────────────────────────────────────────────────
  async createCollect(input: CollectInput): Promise<Result<CollectOutput>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.COLLECT}`,
        headers: this.headers(input.idempotencyKey),
        data: {
          reference_id: input.collectRequestId,
          payer_upi: input.payerHandle,
          payee_account: input.payeeVpa,
          amount: fromMinor(input.amountMinor, input.currency),
          purpose_message: input.narration ?? input.purposeCode,
          // Seconds, and always sent. A collect with no expiry is an open
          // authorisation sitting in a stranger's app indefinitely.
          expiry_time: Math.max(
            1,
            Math.round((input.expiresAt.getTime() - Date.now()) / 1_000),
          ),
        },
      },
      input.traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    const railRef =
      asString(res.value.decentroTxnId) ?? asString(data.decentroTxnId)
    if (!railRef) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Collect accepted with no reference',
          true,
          res.value,
        ),
      )
    }
    return Ok({ railRef, status: 'PENDING' })
  }

  // ── mandate ───────────────────────────────────────────────────────────────
  async createMandate(
    input: CreateMandateInput,
  ): Promise<Result<CreateMandateOutput>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.MANDATE_CREATE}`,
        headers: this.headers(input.idempotencyKey),
        data: {
          reference_id: input.mandateRef,
          payer_upi: input.payerVpa,
          payee_account: input.payeeHandle,
          max_amount: fromMinor(input.maxAmountMinor, input.currency),
          amount_rule: input.amountRule,
          frequency: input.frequency,
          start_date: input.validFrom.toISOString().slice(0, 10),
          end_date: input.validUntil.toISOString().slice(0, 10),
          purpose_message: input.narration ?? input.purposeCode,
        },
      },
      input.traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    const railRef =
      asString(res.value.decentroTxnId) ?? asString(data.decentroTxnId)
    if (!railRef) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Mandate accepted with no reference',
          true,
          res.value,
        ),
      )
    }
    return Ok({
      railRef,
      // The UMN is assigned when the PAYER approves in their own app, not now.
      umn: asString(data.umn) ?? undefined,
      status: 'PENDING',
      approvalUrl: asString(data.approvalUrl) ?? undefined,
    })
  }

  async executeMandate(
    input: ExecuteMandateInput,
  ): Promise<Result<SubmitPayoutOutput>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.MANDATE_EXECUTE}`,
        headers: this.headers(input.idempotencyKey),
        data: {
          reference_id: input.executionId,
          decentro_txn_id: input.mandateRailRef,
          ...(input.umn ? { umn: input.umn } : {}),
          amount: fromMinor(input.amountMinor, input.currency),
          purpose_message: input.narration ?? 'AutoPay debit',
        },
      },
      input.traceId,
    )
    if (!res.ok) return res

    const data = res.value.data ?? {}
    const railRef =
      asString(res.value.decentroTxnId) ?? asString(data.decentroTxnId)
    if (!railRef) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'Mandate debit accepted with no reference',
          true,
          res.value,
        ),
      )
    }
    return Ok({
      railRef,
      status: this.mapSubmitStatus(data.transactionStatus ?? data.status),
      railCode: asString(data.npciResponseCode),
      utr: asString(data.utr) ?? undefined,
    })
  }

  async revokeMandate(railRef: string, traceId: string): Promise<Result<void>> {
    const res = await httpJson<DecentroEnvelope>(
      {
        method: 'POST',
        url: `${this.baseUrl()}${DECENTRO_UPI_PATHS.MANDATE_REVOKE}`,
        headers: this.headers(`revoke_${railRef}`),
        data: { reference_id: `revoke_${railRef}`, decentro_txn_id: railRef },
      },
      traceId,
    )
    return res.ok ? Ok(undefined) : res
  }

  // ── webhooks ──────────────────────────────────────────────────────────────
  /**
   * HMAC over the RAW body, compared in constant time.
   *
   * Raw bytes, not a re-serialised object: `JSON.stringify(req.body)` reorders keys and
   * drops whitespace, so it verifies a different message than the one that was signed —
   * a check that fails on every legitimate webhook and would inevitably be "fixed" by
   * removing it.
   */
  verifyWebhook(headers: Record<string, unknown>, rawBody: string): boolean {
    const secret =
      this.config.get<string>(
        `${ENV.PAYMENTS.WEBHOOK_SECRET_PREFIX}DECENTRO`,
      ) ?? this.config.get<string>(ENV.WEBHOOK.HMAC_SECRET)
    if (!secret) {
      this.logger.error(
        `[${this.verifyWebhook.name}] No webhook secret configured — rejecting`,
      )
      return false
    }

    const provided = asText(headers[DECENTRO_WEBHOOK_SIGNATURE_HEADER]) ?? ''
    if (!provided) return false

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  parseWebhook(body: unknown): RailWebhookEvent | null {
    if (!body || typeof body !== 'object') return null
    const payload = body as Record<string, unknown>
    const data =
      (payload.data as Record<string, unknown> | undefined) ?? payload

    const railRef =
      asString(data.decentroTxnId) ?? asString(payload.decentroTxnId)
    const rawStatus = data.transactionStatus ?? data.status
    const status = this.mapStatus(rawStatus)

    const eventId =
      asString(payload.eventId) ??
      asString(payload.notificationId) ??
      // No event id means no dedupe key, and a webhook we cannot dedupe is one that
      // can settle a transaction twice. A composite of the identifying fields is a
      // weaker guarantee than a vendor id but a far stronger one than none.
      (railRef ? `${railRef}:${asText(rawStatus) ?? 'unknown'}` : undefined)
    if (!eventId) return null

    return {
      eventId,
      kind: asString(payload.eventType)?.includes('mandate')
        ? 'mandate'
        : asString(payload.eventType)?.includes('collect')
          ? 'collect'
          : asString(payload.eventType)?.includes('refund')
            ? 'refund'
            : 'payment',
      railRef: railRef ?? undefined,
      utr: asString(data.utr) ?? asString(data.rrn) ?? undefined,
      status,
      railCode: asString(data.npciResponseCode) ?? asString(data.responseCode),
      amountMinor: this.parseAmount(
        data.amount,
        asString(data.currency) ?? 'INR',
      ),
      currency: asString(data.currency) ?? 'INR',
      objectRef: asString(data.umn) ?? asString(data.mandateId) ?? undefined,
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private baseUrl(): string {
    return this.config
      .getOrThrow<string>(ENV.DECENTRO.BASE_URL)
      .replace(/\/+$/, '')
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [DECENTRO_UPI_HEADERS.CLIENT_ID]: this.config.getOrThrow<string>(
        ENV.DECENTRO.CLIENT_ID,
      ),
      [DECENTRO_UPI_HEADERS.CLIENT_SECRET]: this.config.getOrThrow<string>(
        ENV.DECENTRO.CLIENT_SECRET,
      ),
      [DECENTRO_UPI_HEADERS.MODULE_SECRET]: this.config.getOrThrow<string>(
        ENV.DECENTRO.MODULE_SECRET,
      ),
    }
    if (idempotencyKey) {
      headers[DECENTRO_UPI_HEADERS.IDEMPOTENCY] = idempotencyKey
    }
    return headers
  }

  /**
   * Map a vendor status string.
   *
   * The default is PENDING, and it is the most important line in this class. An
   * unrecognised status is not evidence that nothing happened; downstream it becomes
   * DEEMED, the funds stay in suspense, and a human decides. Defaulting to FAILED would
   * mean a vendor adding one status string caused us to refund senders whose money had
   * already moved.
   */
  private mapStatus(raw: unknown): 'SUCCESS' | 'FAILED' | 'PENDING' {
    const value = (asText(raw) ?? '').toUpperCase()
    if (DECENTRO_UPI_STATUS.SUCCESS.includes(value as never)) return 'SUCCESS'
    if (DECENTRO_UPI_STATUS.FAILED.includes(value as never)) return 'FAILED'
    if (DECENTRO_UPI_STATUS.PENDING.includes(value as never)) return 'PENDING'

    this.logger.warn(
      `[${this.mapStatus.name}] Unrecognised rail status — treating as pending`,
      { raw: value },
    )
    return 'PENDING'
  }

  private mapSubmitStatus(raw: unknown): 'SUCCESS' | 'PENDING' | 'SUBMITTED' {
    const mapped = this.mapStatus(raw)
    // A submit response cannot be "FAILED" in this type: a rejection is carried in the
    // rail code, and the saga decides what to do with it. Collapsing it to SUBMITTED
    // keeps that decision in one place.
    return mapped === 'SUCCESS'
      ? 'SUCCESS'
      : mapped === 'PENDING'
        ? 'PENDING'
        : 'SUBMITTED'
  }

  /**
   * Read a vendor amount back into integer minor units.
   *
   * Returns `undefined` rather than guessing on anything unparseable. The value is only
   * used to cross-check what the rail says it moved against what we asked for, and a
   * fabricated figure there would either raise a false mismatch or hide a real one.
   */
  private parseAmount(raw: unknown, currency: string): bigint | undefined {
    if (raw === undefined || raw === null) return undefined
    try {
      const text = asText(raw)
      if (text === undefined) return undefined
      return majorToMinor(text, currency)
    } catch {
      this.logger.warn(
        `[${this.parseAmount.name}] Could not parse a rail amount`,
        { raw: asText(raw) ?? typeof raw, currency },
      )
      return undefined
    }
  }
}

/**
 * Decentro's envelope: `{ decentroTxnId, status, responseCode, data }`.
 *
 * Everything optional because the shape varies by product and version, and every access
 * is guarded. CONFIRM the concrete shape per endpoint against your dashboard.
 */
interface DecentroEnvelope {
  decentroTxnId?: string
  status?: string
  responseCode?: string
  message?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Coerce a PRIMITIVE vendor field to text.
 *
 * Returns `undefined` for an object or array rather than `"[object Object]"`, which is what
 * a bare `String(value)` would produce. Not pedantry: a vendor that changes `amount` from
 * `"100.50"` to `{ value: "100.50", currency: "INR" }` would otherwise have that literal
 * string flow into an amount parse or a status comparison, and the failure would surface as
 * an unrecognised status (safe, but baffling) rather than as "this field is not a scalar".
 */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return String(value)
  return undefined
}

/** Decentro reports booleans as `true`, `"true"`, `"VALID"` or `"SUCCESS"`. */
function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = (asText(value) ?? '').toUpperCase()
  return text === 'TRUE' || text === 'VALID' || text === 'SUCCESS'
}
