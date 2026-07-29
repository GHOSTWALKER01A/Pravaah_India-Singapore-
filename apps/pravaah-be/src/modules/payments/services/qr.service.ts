import { randomBytes } from 'crypto'

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { DYNAMIC_QR_TTL_MS, type CreateQrDto } from '@pravaah/schema'

import { ENV } from '@/constants/environment.constants'
import { moneyView, toMinor } from '@/modules/payments/money.util'
import {
  buildUpiIntent,
  parseUpiIntent,
  signQr,
  verifyQrSignature,
} from '@/modules/payments/upi-qr.util'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  QrKind,
  UpiHandleStatus,
  type PaymentQr,
} from 'generated/prisma/client'

export interface ScannedQr {
  payeeAddress: string
  payeeName: string | null
  amountMinor: bigint | null
  currency: string
  merchantCode: string | null
  narration: string | null
  /** True when this is one of our own QRs and we can vouch for its contents. */
  known: boolean
  kind: QrKind | null
  qrId: string | null
  /** Whether an amount-bearing QR's signature verified. */
  signatureValid: boolean | null
  /** Why this must not be paid, when it must not be. */
  blockedReason?: string
}

/**
 * UPI QR codes.
 *
 * The two kinds are genuinely different objects wearing the same picture, and treating
 * them alike is a real vulnerability rather than a modelling nicety:
 *
 *  - **STATIC** is amount-less and reusable — the sticker on a shopfront. The payer types
 *    the amount, so the QR is not a payment instruction and cannot be "spent".
 *  - **DYNAMIC** carries an amount, so it IS a payment instruction. It is signed,
 *    short-lived, and consumed on first success. An unsigned amount-bearing QR can be
 *    edited in transit: change `am=1.00` to `am=100.00` in a forwarded image, keep the
 *    merchant's real VPA beside it, and the payer's app faithfully presents the attacker's
 *    number.
 *
 * Scanning is parsed SERVER-SIDE. A QR is attacker-supplied input that resolves to a payee,
 * and two parsers — ours and the app's — that disagree about a malformed one are two
 * different answers to "who gets the money".
 */
@Injectable()
export class QrService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly handles: UpiHandleService,
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: QrService.name })
  }

  /**
   * The HMAC key for dynamic QRs.
   *
   * Falls back to the field-encryption key rather than to a constant, so a development
   * environment is never silently unsigned — an unsigned dynamic QR is editable, and a
   * signing path that is bypassed in development is one nobody has run before production.
   */
  private signingSecret(): string {
    const secret =
      this.config.get<string>(ENV.PAYMENTS.QR_SIGNING_SECRET) ??
      this.config.get<string>(ENV.CRYPTO.FIELD_ENCRYPTION_KEY)
    if (!secret) {
      throw new BadRequestException(
        'QR signing is not configured on this server',
      )
    }
    return secret
  }

  // ── minting ───────────────────────────────────────────────────────────────
  async create(userId: string, dto: CreateQrDto): Promise<PaymentQr> {
    const handle = await this.handles.primary(userId)
    if (!handle || handle.status !== UpiHandleStatus.ACTIVE) {
      throw new BadRequestException(
        'Create and verify a UPI ID before generating a QR code',
      )
    }

    const payee = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycProfile: { select: { verifiedName: true } } },
    })
    const payeeName = payee?.kycProfile?.verifiedName ?? 'Pravaah user'

    // 128 bits of entropy. The reference is printed in public and is the only handle a
    // scanner has, so it must not be guessable — an enumerable reference would let anyone
    // walk other merchants' QRs.
    const ref = `PQR${randomBytes(16).toString('base64url')}`
    const amountMinor = dto.amountMinor ? toMinor(dto.amountMinor) : null

    if (dto.kind === QrKind.DYNAMIC && !amountMinor) {
      throw new BadRequestException('A dynamic QR must carry an amount')
    }

    const expiresAt =
      dto.kind === QrKind.DYNAMIC
        ? new Date(
            Date.now() +
              (dto.expiresInSeconds
                ? dto.expiresInSeconds * 1_000
                : DYNAMIC_QR_TTL_MS),
          )
        : null

    const signature =
      dto.kind === QrKind.DYNAMIC && amountMinor && expiresAt
        ? signQr(this.signingSecret(), {
            ref,
            payeeAddress: handle.vpa,
            amountMinor,
            currency: dto.currency,
            expiresAt,
          })
        : null

    const payload = buildUpiIntent({
      payeeAddress: handle.vpa,
      payeeName,
      amountMinor: amountMinor ?? undefined,
      currency: dto.currency,
      merchantCode: dto.mcc,
      note: dto.narration,
      txnRef: ref,
      signature: signature ?? undefined,
    })

    return this.prisma.paymentQr.create({
      data: {
        userId,
        kind: dto.kind,
        ref,
        payload,
        vpa: handle.vpa,
        amountMinor,
        currency: dto.currency,
        mcc: dto.mcc ?? null,
        purposeCode: dto.purposeCode,
        narration: dto.narration ?? null,
        signature,
        expiresAt,
      },
    })
  }

  list(userId: string): Promise<PaymentQr[]> {
    return this.prisma.paymentQr.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  }

  /** Deactivate a QR — the shopfront sticker is replaced, the old one stops working. */
  async deactivate(userId: string, qrId: string): Promise<PaymentQr> {
    const qr = await this.prisma.paymentQr.findFirst({
      where: { id: qrId, userId },
    })
    if (!qr) throw new NotFoundException('QR code not found')
    return this.prisma.paymentQr.update({
      where: { id: qr.id },
      data: { isActive: false },
    })
  }

  // ── scanning ──────────────────────────────────────────────────────────────
  /**
   * Decode a scanned payload and say whether it may be paid.
   *
   * Returns a `blockedReason` rather than throwing for the cases where the QR parses fine
   * but must not be honoured — expired, spent, deactivated, signature mismatch. The app
   * needs to render the payee it read alongside the reason it is refusing, and an
   * exception loses the first half.
   */
  async scan(payload: string): Promise<ScannedQr> {
    const parsed = parseUpiIntent(payload)
    if (!parsed.ok) {
      throw new BadRequestException(parsed.reason)
    }
    const intent = parsed.intent

    // Ours? The `tr` (transaction reference) is what links a scanned code back to the row
    // we minted, which is what lets us enforce single-use and check the signature.
    const qr = intent.txnRef
      ? await this.prisma.paymentQr.findUnique({
          where: { ref: intent.txnRef },
        })
      : null

    const base: ScannedQr = {
      payeeAddress: intent.payeeAddress,
      payeeName: intent.payeeName ?? null,
      amountMinor: intent.amountMinor ?? null,
      currency: intent.currency,
      merchantCode: intent.merchantCode ?? null,
      narration: intent.note ?? null,
      known: Boolean(qr),
      kind: qr?.kind ?? null,
      qrId: qr?.id ?? null,
      signatureValid: null,
    }

    if (!qr) {
      /**
       * A third party's QR.
       *
       * Payable — most UPI QRs in the world are not ours — but there is nothing to verify,
       * so an amount on it is only as trustworthy as the paper it is printed on. The app
       * shows the payee's resolved bank name and the payer confirms it; that is the
       * control, not the QR.
       */
      return base
    }

    await this.prisma.paymentQr
      .update({ where: { id: qr.id }, data: { scanCount: { increment: 1 } } })
      .catch(() => void 0)

    if (!qr.isActive) {
      return { ...base, blockedReason: 'This QR code has been deactivated' }
    }
    if (qr.expiresAt && qr.expiresAt <= new Date()) {
      return { ...base, blockedReason: 'This QR code has expired' }
    }
    if (qr.consumedAt) {
      // A dynamic QR is a single payment instruction. Honouring it twice is a duplicate
      // charge for one purchase.
      return { ...base, blockedReason: 'This QR code has already been paid' }
    }

    if (qr.kind === QrKind.DYNAMIC) {
      const signatureValid =
        Boolean(qr.signature) &&
        Boolean(intent.signature) &&
        Boolean(qr.amountMinor) &&
        Boolean(qr.expiresAt) &&
        verifyQrSignature(
          this.signingSecret(),
          {
            ref: qr.ref,
            payeeAddress: qr.vpa,
            amountMinor: qr.amountMinor!,
            currency: qr.currency,
            expiresAt: qr.expiresAt!,
          },
          intent.signature!,
        )

      if (!signatureValid) {
        this.logger.error(
          `[${this.scan.name}] Dynamic QR signature failed — refusing to present it`,
          { qrId: qr.id, ref: qr.ref },
        )
        return {
          ...base,
          signatureValid: false,
          blockedReason:
            'This QR code has been altered since it was created. Do not pay it.',
        }
      }

      /**
       * The AMOUNT comes from our row, not from the scanned string.
       *
       * Even with a valid signature. The signature proves the payload was not tampered
       * with, but the stored value is the one we can prove we issued — and using it means
       * a future weakness in the parse cannot change what the payer is asked for.
       */
      return {
        ...base,
        signatureValid: true,
        amountMinor: qr.amountMinor,
        payeeAddress: qr.vpa,
        currency: qr.currency,
      }
    }

    return { ...base, payeeAddress: qr.vpa, currency: qr.currency }
  }

  /**
   * Burn a dynamic QR on the payment that consumed it. Atomic.
   *
   * A conditional update, so two payers scanning the same dynamic QR simultaneously cannot
   * both succeed — the loser gets a conflict rather than a second charge against one
   * invoice. Static QRs are reusable by definition and are never consumed.
   */
  async consume(qrId: string, transactionId: string): Promise<void> {
    const qr = await this.prisma.paymentQr.findUnique({ where: { id: qrId } })
    if (!qr || qr.kind !== QrKind.DYNAMIC) return

    const consumed = await this.prisma.paymentQr.updateMany({
      where: { id: qrId, consumedAt: null },
      data: { consumedAt: new Date(), consumedByTxn: transactionId },
    })
    if (consumed.count === 0) {
      throw new ConflictException(
        'This QR code has already been paid by someone else',
      )
    }
  }

  /** Wire-shape for a QR, with the amount in every representation a client needs. */
  describe(qr: PaymentQr) {
    return {
      id: qr.id,
      ref: qr.ref,
      kind: qr.kind,
      payload: qr.payload,
      vpa: qr.vpa,
      amount: qr.amountMinor ? moneyView(qr.amountMinor, qr.currency) : null,
      currency: qr.currency,
      mcc: qr.mcc,
      narration: qr.narration,
      isActive: qr.isActive,
      scanCount: qr.scanCount,
      expiresAt: qr.expiresAt,
      consumedAt: qr.consumedAt,
      createdAt: qr.createdAt,
    }
  }
}
