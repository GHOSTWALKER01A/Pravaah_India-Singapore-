import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'
import { ResponseBuilder } from '@/utils/response-builder'

import { moneyView } from '@/modules/payments/money.util'
import { MOCK_UPI_ROUTES } from '@/modules/payments/payments.route'
import { CollectService } from '@/modules/payments/services/collect.service'
import { MandateService } from '@/modules/payments/services/mandate.service'
import { RailEventService } from '@/modules/payments/services/rail-event.service'
import { UpiSimProvider } from '@/modules/payments/providers/simulated-rail.provider'
import { normaliseVpa } from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import { CollectStatus } from 'generated/prisma/client'

/**
 * The mock rail — standing in for the PAYER's own PSP app.
 *
 * Necessary, because the one thing we deliberately cannot do is approve a payment on a payer's
 * behalf. A real collect or AutoPay mandate is authorised inside the payer's bank app with their
 * UPI PIN, in a secure component we never touch. Without something to play that part, the
 * inbound half of UPI — collect, topup, AutoPay approval — cannot be exercised at all.
 *
 * **Refused outright when `NODE_ENV=production`.** These endpoints carry exactly the authority a
 * real rail has: they can approve a debit against somebody's account. A guard that merely logged
 * a warning would be a route to move real money with no authentication, and "it is only for
 * demos" is not a property the deployment can check.
 *
 * {@link fireWebhook} deliberately goes through the REAL webhook path with a real signature,
 * rather than calling the services directly. A demo that bypassed signature verification and
 * replay dedupe would be demonstrating a code path that does not exist in production.
 */
@Controller(MOCK_UPI_ROUTES.BASE)
export class MockUpiController {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly collects: CollectService,
    private readonly mandates: MandateService,
    private readonly railEvents: RailEventService,
    private readonly sim: UpiSimProvider,
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockUpiController.name })
  }

  /**
   * The kill switch.
   *
   * Called at the top of every handler rather than as a guard on the class, so it cannot be
   * removed from one route by accident. Fails CLOSED: an unset `NODE_ENV` is treated as
   * non-production, but anything explicitly production is refused.
   */
  private assertNotProduction(): void {
    if (this.config.get<string>(ENV.NODE_ENV) === 'production') {
      throw new ForbiddenException(
        'The mock UPI rail is not available in production',
      )
    }
  }

  /**
   * What is waiting for this payer — the inbox their own PSP app would show.
   *
   * Keyed by VPA rather than by session, because the payer here is a COUNTERPARTY: in a demo
   * they are often not a Pravaah user at all, which is the whole point of a rail.
   */
  @Get(MOCK_UPI_ROUTES.PENDING)
  async pending(@Param('vpa') vpa: string) {
    this.assertNotProduction()
    const payerHandle = normaliseVpa(vpa)

    const requests = await this.prisma.collectRequest.findMany({
      where: {
        payerHandle,
        status: { in: [CollectStatus.CREATED, CollectStatus.PENDING] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { pravaahId: true } },
      },
    })

    return ResponseBuilder.success(
      requests.map((request) => ({
        collectRef: request.railRef ?? request.id,
        collectId: request.id,
        // The payee, as a payer's app would display them.
        requestedBy: request.user.pravaahId,
        amount: moneyView(request.amountMinor, request.currency),
        narration: request.narration,
        expiresAt: request.expiresAt,
      })),
      `Pending requests for ${payerHandle}`,
    )
  }

  /**
   * Approve or decline a collect, as the payer's app would.
   *
   * Routed through {@link CollectService.applyRailDecision} — the same method a real signed
   * webhook reaches — so the credit, the ledger posting and the state machine all behave exactly
   * as they would in production.
   */
  @Post(MOCK_UPI_ROUTES.COLLECT_RESPOND)
  async respondToCollect(
    @Param('collectRef') collectRef: string,
    @Body('approve') approve: boolean,
    @Body('reason') reason?: string,
  ) {
    this.assertNotProduction()

    const collect = await this.prisma.collectRequest.findFirst({
      where: { OR: [{ railRef: collectRef }, { id: collectRef }] },
    })
    if (!collect) throw new NotFoundException('No such payment request')

    const updated = await this.collects.applyRailDecision({
      collectId: collect.id,
      // `ZA` is the real NPCI code for "declined by the customer", so the decline path
      // exercises the same classification a live rail would trigger.
      decision: approve ? 'APPROVED' : 'DECLINED',
      railCode: approve ? '00' : 'ZA',
      reason: approve ? null : (reason ?? 'Declined by the payer'),
    })

    this.logger.info(
      `[${this.respondToCollect.name}] Mock payer ${approve ? 'approved' : 'declined'} a collect`,
      { collectId: collect.id },
    )
    return ResponseBuilder.success(
      { collectId: collect.id, status: updated?.status ?? collect.status },
      approve ? 'Payment approved' : 'Payment declined',
    )
  }

  /** Approve an AutoPay mandate, as the payer's authorisation screen would. */
  @Post(MOCK_UPI_ROUTES.MANDATE_APPROVE)
  async approveMandate(
    @Param('mandateRef') mandateRef: string,
    @Body('approve') approve = true,
  ) {
    this.assertNotProduction()

    const mandate = await this.mandates.applyRailDecision({
      mandateRef,
      approved: approve !== false,
      // The UPI Mandate Number the rail assigns on approval — absent until this moment, which
      // is why the create response does not carry one.
      umn: approve !== false ? `UMN${mandateRef.slice(-12)}` : null,
      reason: approve === false ? 'Declined by the payer' : null,
    })
    if (!mandate) throw new NotFoundException('No such mandate')

    return ResponseBuilder.success(
      { mandateId: mandate.id, status: mandate.status, umn: mandate.umn },
      approve !== false ? 'AutoPay approved' : 'AutoPay declined',
    )
  }

  /**
   * Fire a signed webhook at our own endpoint.
   *
   * The demo path for the money-safety showpiece: force a late SUCCESS for a transaction we had
   * already marked FAILED, and watch reconciliation correct itself.
   *
   * Signed with the simulator's real key and ingested through {@link RailEventService}, so
   * signature verification and replay dedupe both apply. Bypassing them would make the demo
   * prove nothing about the production path.
   */
  @Post(MOCK_UPI_ROUTES.FIRE_WEBHOOK)
  async fireWebhook(
    @Body()
    body: {
      railRef: string
      status: 'SUCCESS' | 'FAILED' | 'PENDING'
      railCode?: string
      kind?: 'payment' | 'refund' | 'collect' | 'mandate'
      utr?: string
      eventId?: string
    },
  ) {
    this.assertNotProduction()
    if (!body?.railRef || !body?.status) {
      throw new NotFoundException('railRef and status are required')
    }

    const payload = {
      eventId: body.eventId ?? `mock_${body.railRef}_${body.status}`,
      railRef: body.railRef,
      status: body.status,
      railCode: body.railCode ?? (body.status === 'SUCCESS' ? '00' : 'U30'),
      kind: body.kind ?? 'payment',
      utr: body.utr,
    }
    const rawBody = JSON.stringify(payload)

    const event = this.sim.parseWebhook(payload)
    if (!event) throw new NotFoundException('Could not build that event')

    const result = await this.railEvents.ingest({
      provider: this.sim.name,
      rawBody,
      // Signed for real, then verified for real — so the path exercised is the production one.
      signatureVerified: this.sim.verifyWebhook(
        { 'x-rail-signature': this.sim.signWebhook(rawBody) },
        rawBody,
      ),
      event,
    })

    this.logger.warn(`[${this.fireWebhook.name}] Mock rail webhook fired`, {
      railRef: body.railRef,
      status: body.status,
      outcome: result.outcome,
    })
    return ResponseBuilder.success(result, `Webhook ${result.outcome}`)
  }

  /**
   * How to script the simulator.
   *
   * Documentation rather than a mutation, on purpose: forcing an outcome is an ENVIRONMENT
   * setting (`PAYMENTS_SIM_FORCE_OUTCOME`), so it survives a restart and is visible in the
   * deployment rather than hidden in a process's memory where nobody can see why every payment
   * is failing.
   */
  @Get(MOCK_UPI_ROUTES.SCRIPT)
  script() {
    this.assertNotProduction()
    return ResponseBuilder.success(
      {
        env: ENV.PAYMENTS.SIM.FORCE_OUTCOME,
        outcomes: {
          success: 'Settles immediately',
          pending: 'Accepted, settles after PAYMENTS_SIM_SETTLE_DELAY_MS',
          fail: 'Rejected by the rail with a real NPCI code',
          timeout:
            'Never answers — the saga must reach DEEMED with funds in suspense',
          'late-success':
            'Reports FAILED, then SUCCESS — reconciliation must correct itself and book a RECOVERY',
        },
        note: 'Set the environment variable and restart, or leave it unset to use the configured failure percentages.',
      },
      'Simulator scripting',
    )
  }
}
