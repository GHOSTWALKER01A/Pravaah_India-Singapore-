import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  SUPPORTED_CURRENCIES,
  type TopupDto,
  type TransferListQueryDto,
  type WithdrawDto,
} from '@pravaah/schema'

import { moneyView, toMinor } from '@/modules/payments/money.util'
import { isUserVisibleSuccess } from '@/modules/payments/payments.state'
import { BeneficiaryService } from '@/modules/payments/services/beneficiary.service'
import { CollectService } from '@/modules/payments/services/collect.service'
import { LedgerService } from '@/modules/payments/services/ledger.service'
import { LimitService } from '@/modules/payments/services/limit.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { maskHandle } from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  AccountType,
  Corridor,
  LedgerDirection,
  TxnStatus,
  TxnType,
  type Transaction,
} from 'generated/prisma/client'

/**
 * The wallet — balances, statement, and the two flows that move money across the
 * platform's edge.
 *
 * A balance here is always DERIVED from ledger entries, never read from a column. That is
 * the same rule as `LedgerService.balance` and it is repeated at this layer because this is
 * where the temptation to cache lives: the wallet screen is the hottest read in the app,
 * and a cached balance is a second source of truth that will eventually disagree with the
 * money.
 *
 * Topup and withdrawal are separate from `create`-a-transfer, and deliberately so. Both
 * have the user's OWN account as the counterparty, which exempts them from the
 * new-beneficiary cooling period — so the own-account check has to live on a route that can
 * enforce it, not be a flag on the generic transfer path.
 */
@Injectable()
export class WalletService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly limits: LimitService,
    private readonly orchestrator: TransferOrchestratorService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly handles: UpiHandleService,
    private readonly collects: CollectService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: WalletService.name })
  }

  // ── overview ──────────────────────────────────────────────────────────────
  /**
   * Everything the wallet screen needs, in one call.
   *
   * Includes the limit headroom, because a balance without it is misleading: a user with
   * ₹50,000 and ₹2,000 of daily limit left cannot send ₹10,000, and finding that out at the
   * confirmation screen is a worse experience than being told up front.
   */
  async overview(userId: string) {
    const [balances, handles, domesticLimits, crossBorderLimits] =
      await Promise.all([
        this.ledger.userBalances(userId),
        this.handles.list(userId),
        this.limits.usage(userId, Corridor.DOMESTIC),
        this.limits.usage(userId, Corridor.CROSS_BORDER),
      ])

    // Present every supported currency, even at zero. A wallet that hides a
    // zero-balance currency makes "where did my SGD go?" a support ticket.
    const byCurrency = new Map(
      balances
        .filter((entry) => entry.account.type === AccountType.USER_WALLET)
        .map((entry) => [entry.account.currency, entry.balance]),
    )

    return {
      balances: Object.values(SUPPORTED_CURRENCIES).map((currency) => ({
        ...moneyView(byCurrency.get(currency.code) ?? 0n, currency.code),
        label: currency.label,
      })),
      upiHandles: handles.map((handle) => this.handles.describe(handle)),
      limits: {
        domestic: this.describeLimits(domesticLimits),
        crossBorder: this.describeLimits(crossBorderLimits),
      },
    }
  }

  private describeLimits(usage: Awaited<ReturnType<LimitService['usage']>>) {
    return {
      currency: usage.currency,
      perTransaction: moneyView(usage.perTxnCapMinor, usage.currency),
      dailyCap: moneyView(usage.dailyCapMinor, usage.currency),
      dailyUsed: moneyView(usage.dailyUsedMinor, usage.currency),
      dailyRemaining: moneyView(usage.dailyRemainingMinor, usage.currency),
      dailyCountCap: usage.dailyCountCap,
      dailyUsedCount: usage.dailyUsedCount,
      resetAt: usage.dailyResetAt,
      annualCap: usage.annualCapMinor
        ? moneyView(usage.annualCapMinor, usage.currency)
        : null,
      annualRemaining: usage.annualRemainingMinor
        ? moneyView(usage.annualRemainingMinor, usage.currency)
        : null,
      newPayeeCap: moneyView(usage.newBeneficiaryCapMinor, usage.currency),
    }
  }

  // ── statement ─────────────────────────────────────────────────────────────
  /**
   * The account statement, built from LEDGER ENTRIES rather than from transactions.
   *
   * The distinction matters. A transaction list tells the user what they tried to do; a
   * ledger statement tells them what happened to their money — including the reserve, the
   * refund, and the fee as separate lines. When somebody disputes a balance, this is the
   * document that answers them, and it is derived from the same rows the balance is.
   */
  async statement(
    userId: string,
    options: { currency?: string; limit?: number; offset?: number } = {},
  ) {
    const wallets = await this.prisma.ledgerAccount.findMany({
      where: {
        ownerType: 'USER',
        ownerId: userId,
        type: AccountType.USER_WALLET,
        ...(options.currency ? { currency: options.currency } : {}),
      },
      select: { id: true, currency: true },
    })
    if (wallets.length === 0) return { items: [], total: 0 }

    const where = { accountId: { in: wallets.map((wallet) => wallet.id) } }
    const [entries, total] = await this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { postedAt: 'desc' },
        include: {
          transaction: {
            select: {
              id: true,
              type: true,
              status: true,
              counterpartyName: true,
              counterpartyHandle: true,
              narration: true,
              utr: true,
            },
          },
        },
        take: options.limit ?? 50,
        skip: options.offset ?? 0,
      }),
      this.prisma.ledgerEntry.count({ where }),
    ])

    return {
      items: entries.map((entry) => ({
        id: entry.id,
        // Signed for display: a credit adds, a debit subtracts. The stored amount is
        // always positive; the sign is the direction, applied once, here.
        direction: entry.direction,
        amount: moneyView(entry.amountMinor, entry.currency),
        signedMinor:
          entry.direction === LedgerDirection.CREDIT
            ? entry.amountMinor.toString()
            : `-${entry.amountMinor.toString()}`,
        leg: entry.leg,
        postedAt: entry.postedAt,
        transaction: entry.transaction
          ? {
              id: entry.transaction.id,
              type: entry.transaction.type,
              status: entry.transaction.status,
              counterpartyName: entry.transaction.counterpartyName,
              counterparty: maskHandle(entry.transaction.counterpartyHandle),
              narration: entry.transaction.narration,
              utr: entry.transaction.utr,
            }
          : null,
      })),
      total,
    }
  }

  /** The transaction history, which is what the user thinks of as "payments". */
  async transactions(
    userId: string,
    query: TransferListQueryDto,
  ): Promise<{ items: unknown[]; total: number }> {
    const where = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.beneficiaryId ? { beneficiaryId: query.beneficiaryId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.transaction.count({ where }),
    ])

    return { items: items.map((item) => this.describe(item)), total }
  }

  // ── topup ─────────────────────────────────────────────────────────────────
  /**
   * Add money: a UPI collect raised against the user's OWN account.
   *
   * Modelled as a collect because that is literally what it is — a pull from an account the
   * user controls, authorised in their bank's app with their UPI PIN. We never hold the
   * credential, and the wallet is credited only when the rail confirms the debit went
   * through.
   */
  async topup(
    userId: string,
    dto: TopupDto,
    idempotencyKey: string,
  ): Promise<unknown> {
    const source = await this.beneficiaries.get(userId, dto.sourceBeneficiaryId)
    if (!source.isSelf) {
      /**
       * The own-account check.
       *
       * Without it, "add money" becomes a way to pull funds from any address a user can
       * name — which is a collect request wearing a friendlier label, and it would bypass
       * the payer-consent framing entirely.
       */
      throw new BadRequestException(
        'Money can only be added from an account verified as your own',
      )
    }

    const handle = await this.handles.primary(userId)
    if (!handle) {
      throw new BadRequestException(
        'Create and verify a UPI ID before adding money',
      )
    }

    const collect = await this.collects.create(
      userId,
      {
        payerHandle: source.handle,
        amountMinor: dto.amountMinor,
        currency: dto.currency,
        purposeCode: 'WALLET_TOPUP',
        narration: 'Add money to Pravaah',
        expiresInSeconds: 300,
      },
      idempotencyKey,
    )

    this.logger.info(`[${this.topup.name}] Topup collect raised`, {
      userId,
      collectId: collect.id,
    })
    return {
      collectId: collect.id,
      status: collect.status,
      amount: moneyView(collect.amountMinor, collect.currency),
      expiresAt: collect.expiresAt,
      // The user has to approve in their bank's app; the UI needs to say so.
      nextStep: 'Approve the request in your UPI app to complete the top-up',
    }
  }

  // ── withdrawal ────────────────────────────────────────────────────────────
  /**
   * Move wallet funds out to the user's own verified bank account.
   *
   * Runs through the ordinary saga — reserve, submit, settle — with the payout booked on the
   * WITHDRAW leg. No quote is involved because the price is the identity: same currency, no
   * fee, so there is nothing to lock and nothing the user could have been shown wrongly.
   */
  async withdraw(
    userId: string,
    dto: WithdrawDto,
    idempotencyKey: string,
    context: { ipAddress?: string | null } = {},
  ): Promise<unknown> {
    const destination = await this.beneficiaries.get(
      userId,
      dto.destBeneficiaryId,
    )
    if (!destination.isSelf) {
      throw new BadRequestException(
        'Withdrawals can only be sent to an account verified as your own',
      )
    }
    await this.beneficiaries.assertPayable(
      userId,
      destination.id,
      Corridor.DOMESTIC,
    )

    const amountMinor = toMinor(dto.amountMinor)
    if (destination.currency !== dto.currency) {
      throw new BadRequestException(
        `That account is held in ${destination.currency}`,
      )
    }

    // Pre-flight, so the common rejection is a clean error rather than a transaction the
    // user watches fail.
    await this.limits.assertWithin({
      userId,
      corridor: Corridor.DOMESTIC,
      amountMinor,
      beneficiaryId: destination.id,
    })

    const transaction = await this.orchestrator.createRaw({
      userId,
      type: TxnType.WITHDRAWAL,
      currency: dto.currency,
      amountMinor,
      counterpartyHandle: destination.handle,
      counterpartyName: destination.registeredName,
      beneficiaryId: destination.id,
      purposeCode: 'WALLET_WITHDRAWAL',
      narration: 'Withdrawal to bank account',
      idempotencyKey,
      status: TxnStatus.VALIDATED,
      ipAddress: context.ipAddress,
    })

    const driven = await this.orchestrator.drive(transaction.id)
    return this.describe(driven)
  }

  // ── projection ────────────────────────────────────────────────────────────
  /**
   * The wire shape of a transaction.
   *
   * `isSuccess` is derived through `isUserVisibleSuccess` rather than compared against a
   * status string, because only a CONFIRMED settlement may be shown as sent. A receipt
   * rendered at PENDING is one the user acts on — hands over the goods, closes the loan —
   * before the money exists.
   */
  describe(transaction: Transaction) {
    return {
      id: transaction.id,
      type: transaction.type,
      direction: transaction.direction,
      corridor: transaction.corridor,
      rail: transaction.rail,
      status: transaction.status,
      isSuccess: isUserVisibleSuccess(transaction.status),

      youSend: moneyView(transaction.sourceAmount, transaction.sourceCurrency),
      theyGet: moneyView(transaction.destAmount, transaction.destCurrency),
      fee: moneyView(transaction.feeMinor, transaction.sourceCurrency),
      tax: moneyView(transaction.taxMinor, transaction.sourceCurrency),
      totalDebit: moneyView(
        transaction.totalDebitMinor,
        transaction.sourceCurrency,
      ),
      refunded: moneyView(
        transaction.refundedMinor,
        transaction.sourceCurrency,
      ),
      fxRateE8: transaction.fxRateE8?.toString() ?? null,

      counterpartyName: transaction.counterpartyName,
      // Masked, always. A transaction list is the most-screenshotted surface in a payments
      // app, and a full VPA is a directly payable address.
      counterparty: maskHandle(transaction.counterpartyHandle),
      purposeCode: transaction.purposeCode,
      narration: transaction.narration,

      utr: transaction.utr,
      failureReason: transaction.failureReason,
      createdAt: transaction.createdAt,
      completedAt: transaction.completedAt,
    }
  }
}
