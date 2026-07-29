import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CreateQrSchema,
  ParseQrSchema,
  PayQrSchema,
  type CreateQrDto,
  type ParseQrDto,
  type PayQrDto,
} from '@pravaah/schema'

import {
  ClientIp,
  IdempotencyKey,
} from '@/common/decorators/idempotency-key.decorator'
import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { moneyView } from '@/modules/payments/money.util'
import { QR_ROUTES } from '@/modules/payments/payments.route'
import { BeneficiaryService } from '@/modules/payments/services/beneficiary.service'
import {
  IDEMPOTENCY_SCOPE,
  IdempotencyService,
} from '@/modules/payments/services/idempotency.service'
import { QrService } from '@/modules/payments/services/qr.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { WalletService } from '@/modules/payments/services/wallet.service'

import { BeneficiaryHandleType, TxnType } from 'generated/prisma/client'

/**
 * UPI QR — minting, scanning and paying.
 *
 * Scanning is parsed SERVER-SIDE, and that is a security decision rather than an architectural
 * preference. A QR is attacker-supplied input that resolves to a payee and an amount: whoever
 * prints the code chooses every byte. Two parsers — ours and the app's — that disagree about a
 * malformed one are two different answers to "who gets the money", so there is exactly one
 * parser and the app asks it.
 */
@Controller(QR_ROUTES.BASE)
@UseGuards(AuthGuard)
export class QrController {
  private readonly logger: AppLogger

  constructor(
    private readonly qr: QrService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly wallet: WalletService,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: QrController.name })
  }

  /** Mint a QR — a reusable shopfront code, or a signed single-use one for an amount. */
  @Post(QR_ROUTES.CREATE)
  async create(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateQrSchema)) dto: CreateQrDto,
  ) {
    const created = await this.qr.create(user.id, dto)
    return ResponseBuilder.success(
      this.qr.describe(created),
      dto.kind === 'DYNAMIC'
        ? 'One-time QR ready — it expires and can only be paid once'
        : 'QR ready — reusable, and the payer enters the amount',
    )
  }

  @Get(QR_ROUTES.LIST)
  async list(@User() user: AuthenticatedUser) {
    const items = await this.qr.list(user.id)
    return ResponseBuilder.success(
      items.map((item) => this.qr.describe(item)),
      'Your QR codes',
    )
  }

  /**
   * Decode a scanned payload.
   *
   * 200, not 201 — nothing is created. Returns the payee it read together with a
   * `blockedReason` when the code parses but must not be honoured (expired, already paid,
   * signature mismatch). The app needs both halves: the reason alone leaves the user staring
   * at a refusal with no idea what they scanned.
   */
  @Post(QR_ROUTES.SCAN)
  @HttpCode(HttpStatus.OK)
  async scan(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ParseQrSchema)) dto: ParseQrDto,
  ) {
    const scanned = await this.qr.scan(dto.payload)

    /**
     * Resolve the payee's bank-registered name as part of the scan.
     *
     * The QR's own `pn` parameter is chosen by whoever printed it and proves nothing. The
     * bank-held name is the control, and returning it here means the confirmation screen has it
     * without a second round trip.
     */
    const resolved = await this.beneficiaries.resolve(
      user.id,
      scanned.payeeAddress,
      BeneficiaryHandleType.UPI_VPA,
    )

    return ResponseBuilder.success(
      {
        payeeAddress: scanned.payeeAddress,
        // From the QR — advisory only, and labelled as such.
        printedName: scanned.payeeName,
        // From the payee's bank. This is the one the payer must confirm.
        registeredName: resolved.registeredName,
        bankName: resolved.bankName ?? null,
        reachable: resolved.reachable,
        amount: scanned.amountMinor
          ? moneyView(scanned.amountMinor, scanned.currency)
          : null,
        // A static QR has no amount: the payer types it, which is what makes it reusable.
        amountEditable: scanned.amountMinor === null,
        currency: scanned.currency,
        merchantCode: scanned.merchantCode,
        narration: scanned.narration,
        isPravaahQr: scanned.known,
        kind: scanned.kind,
        signatureValid: scanned.signatureValid,
        payable: !scanned.blockedReason && resolved.reachable,
        blockedReason:
          scanned.blockedReason ??
          (resolved.reachable ? null : (resolved.reason ?? null)),
      },
      scanned.blockedReason ?? 'Scanned',
    )
  }

  /**
   * Pay a scanned QR.
   *
   * The amount still comes from a quote: a scanned code PROPOSES an amount, it does not get to
   * set the price. And the payee is resolved and confirmed exactly as for any other transfer —
   * a QR is a convenient way to type an address, not a reason to skip the name check.
   */
  @Post(QR_ROUTES.PAY)
  async pay(
    @User() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @ClientIp() ipAddress: string | null,
    @Body(new ZodValidationPipe(PayQrSchema)) dto: PayQrDto,
  ) {
    const scanned = await this.qr.scan(dto.payload)
    if (scanned.blockedReason) {
      throw new BadRequestException(scanned.blockedReason)
    }

    const result = await this.idempotency.runOnce(
      {
        userId: user.id,
        scope: IDEMPOTENCY_SCOPE.QR_PAY,
        key: idempotencyKey,
        body: dto,
      },
      async () => {
        /**
         * The QR's payee becomes a beneficiary before it can be paid.
         *
         * Not a formality: adding it runs the name resolution, the screening and the
         * new-payee cooling period. A "pay by QR" path that bypassed those would be a way to
         * send any amount to any address on the first scan, which is exactly the flow every
         * UPI scam uses.
         */
        const beneficiary = await this.beneficiaries.add(user.id, {
          handleType: 'UPI_VPA',
          vpa: scanned.payeeAddress,
          displayName: scanned.payeeName ?? scanned.payeeAddress,
          isSelf: false,
        })

        const transaction = await this.orchestrator.create(
          user.id,
          {
            beneficiaryId: beneficiary.id,
            quoteId: dto.quoteId,
            // A merchant code means a merchant payment; without one it is person-to-person.
            type: scanned.merchantCode ? TxnType.P2M : TxnType.P2P,
            purposeCode: scanned.merchantCode
              ? 'MERCHANT_PAYMENT'
              : 'P2P_TRANSFER',
            narration: dto.narration ?? scanned.narration ?? undefined,
            mcc: scanned.merchantCode ?? undefined,
            expectedTotalDebitMinor: dto.expectedTotalDebitMinor,
            confirmedRegisteredName: dto.confirmedRegisteredName,
            confirmedName: true,
            deviceId: dto.deviceId,
          },
          { idempotencyKey, ipAddress },
        )

        // Burn a dynamic QR against the payment that consumed it. Atomic, so two payers
        // scanning the same one cannot both succeed.
        if (scanned.qrId && scanned.kind === 'DYNAMIC') {
          await this.qr.consume(scanned.qrId, transaction.id)
        }

        return this.wallet.describe(transaction)
      },
    )

    return ResponseBuilder.success(
      result.value,
      result.replayed
        ? 'That payment was already submitted'
        : 'Payment submitted',
    )
  }

  @Post(QR_ROUTES.DEACTIVATE)
  async deactivate(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const updated = await this.qr.deactivate(user.id, id)
    return ResponseBuilder.success(
      this.qr.describe(updated),
      'QR code deactivated',
    )
  }
}
