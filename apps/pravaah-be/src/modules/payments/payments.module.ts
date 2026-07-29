import { Module } from '@nestjs/common'
import { PassportModule as NestPassportModule } from '@nestjs/passport'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'

import { FraudModule } from '@/modules/fraud/fraud.module'

import { AdminPaymentsController } from '@/modules/payments/admin-payments.controller'
import { BeneficiaryController } from '@/modules/payments/beneficiary.controller'
import { CollectController } from '@/modules/payments/collect.controller'
import { DisputeController } from '@/modules/payments/dispute.controller'
import { MandateController } from '@/modules/payments/mandate.controller'
import { MockUpiController } from '@/modules/payments/mock-upi.controller'
import { PaymentWebhookController } from '@/modules/payments/payment-webhook.controller'
import { PaymentsController } from '@/modules/payments/payments.controller'
import { QrController } from '@/modules/payments/qr.controller'
import { TransferController } from '@/modules/payments/transfer.controller'

import { DecentroUpiProvider } from '@/modules/payments/providers/decentro-upi.provider'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import {
  UpiPayNowSimProvider,
  UpiSimProvider,
} from '@/modules/payments/providers/simulated-rail.provider'

import { BeneficiaryService } from '@/modules/payments/services/beneficiary.service'
import { CollectService } from '@/modules/payments/services/collect.service'
import { DisputeService } from '@/modules/payments/services/dispute.service'
import { FxService } from '@/modules/payments/services/fx.service'
import { IdempotencyService } from '@/modules/payments/services/idempotency.service'
import { LedgerService } from '@/modules/payments/services/ledger.service'
import { LimitService } from '@/modules/payments/services/limit.service'
import { MandateService } from '@/modules/payments/services/mandate.service'
import { PayeeScreeningService } from '@/modules/payments/services/payee-screening.service'
import { PaymentRiskActionAdapter } from '@/modules/payments/services/payment-risk-action.adapter'
import { PaymentRiskService } from '@/modules/payments/services/payment-risk.service'
import { PaymentSchedulerService } from '@/modules/payments/services/payment-scheduler.service'
import { PaymentsAdminService } from '@/modules/payments/services/payments-admin.service'
import { QrService } from '@/modules/payments/services/qr.service'
import { RailEventService } from '@/modules/payments/services/rail-event.service'
import { ReconciliationService } from '@/modules/payments/services/reconciliation.service'
import { ReversalService } from '@/modules/payments/services/reversal.service'
import { TransferOrchestratorService } from '@/modules/payments/services/transfer-orchestrator.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import { WalletService } from '@/modules/payments/services/wallet.service'

/**
 * M4 — Cross-border money movement (UPI ↔ PayNow · ledger · idempotency).
 *
 * M3 made a person's reputation trustworthy across borders. M4 is what ACTS on that trust: it
 * moves money. Remittance, loan disbursal, loan repayment — and M5 reuses it for insurance
 * premiums.
 *
 * This is the most dangerous module in the product. A bug in M3 renders an ugly card; a bug here
 * double-spends, loses, or strands real money. So it rests on four invariants that are never
 * violated, and each one is enforced by a MECHANISM rather than by discipline:
 *
 *  1. **Integer minor units, everywhere.** Not one Float or Decimal column in the M4 schema, and
 *     `money.util.ts` is the only place arithmetic happens. Even the FX rate is an integer
 *     (`rateE8`), because every code path that reaches for a `Decimal` ends at `Number(rate)` —
 *     the exact float conversion this module forbids.
 *  2. **A double-entry, append-only ledger.** `LedgerService.post` rejects any set of entries
 *     that does not net to zero per currency, and balances are DERIVED — never stored, never
 *     cached. The trial balance follows for free, which makes a non-zero result a genuine alarm:
 *     it can only mean entries reached the table without passing through the ledger.
 *  3. **Idempotency at the database level.** Not a status check — a UNIQUE INDEX. The
 *     `(transaction, account, direction, leg, legRef)` constraint is what stops two concurrent
 *     webhooks from crediting a beneficiary twice, because both read `PENDING` before either
 *     writes and no amount of application-level guarding can arbitrate that.
 *  4. **Reconciliation as the source of truth.** What the rail actually did outranks what we
 *     believed. `ReconciliationService` will move a FAILED transaction to SUCCESS, because a
 *     payment we gave up on that settled anyway is the most expensive event in payments and the
 *     only defence is being willing to correct ourselves.
 *
 * ## Provider reality
 *
 * Selected by CORRIDOR, and the two are not symmetric:
 *
 *  - **Domestic (India) — LIVE.** Decentro's UPI sandbox, behind {@link DecentroUpiProvider}.
 *  - **Cross-border (UPI↔PayNow) — SIMULATED, with no live option.** The linkage is a BANK rail
 *    (DBS Singapore / Liquid Group) reached through a regulated PSP, not an API anyone can sign
 *    up for. The simulator is faithful rather than convenient: it emits PENDING, FAILED, the
 *    never-answers case, and the money-losing "late SUCCESS after we timed out", so the
 *    reconciliation logic that exists to survive those has actually run. Production requires a
 *    PSP or sponsor-bank partnership (Nium, Thunes, Wise Platform) under RBI/MAS licensing —
 *    stated plainly here because a simulator presented as a rail is the one thing that would
 *    discredit everything else in the module.
 *
 * Depends on M0 (a VERIFIED identity, device binding, penny-drop name checks) and reads M3 (a
 * lender records the presentation that justified a disbursal). Exports the ledger, the saga and
 * reconciliation so M5 can settle insurance premiums through the same books rather than a second
 * set.
 */
@Module({
  imports: [
    NestPassportModule,
    /**
     * M6, for the risk engine and the step-up orchestration.
     *
     * Imported as a MODULE so M4 gets `RiskService`, `StepUpService` and
     * `RiskActionRegistry` rather than reaching for the risk tables directly. Same
     * reasoning M4's own comment gives M5 about the ledger: the aggregation rule, the
     * decision ladder and the hard-signal bypass live inside those services, and a module
     * querying `RiskAssessment` itself would bypass all three while appearing to reuse M6.
     *
     * The arrow points M4 → M6 and never back. The one place it needs to reverse — an
     * analyst releasing a held transfer — goes through `PaymentRiskActionAdapter`, which
     * registers into M6's registry rather than being injected by it.
     */
    FraudModule,
  ],
  controllers: [
    // Holder-facing (JWT).
    PaymentsController,
    BeneficiaryController,
    TransferController,
    CollectController,
    QrController,
    MandateController,
    DisputeController,
    /**
     * Rail callbacks — unauthenticated by session, verified by per-provider HMAC over the raw
     * bytes. Registered here but routed outside the `payments` prefix, so no session guard can
     * be inherited onto an endpoint a rail calls without a JWT.
     */
    PaymentWebhookController,
    /**
     * The mock rail — the payer's "PSP app". Refused when NODE_ENV=production, because these
     * endpoints carry exactly the authority a real rail has: they can approve a debit against
     * somebody's account.
     */
    MockUpiController,
    // Admin console (admin JWT + RBAC).
    AdminPaymentsController,
  ],
  providers: [
    // ── the rails ───────────────────────────────────────────────────────────
    DecentroUpiProvider,
    UpiSimProvider,
    UpiPayNowSimProvider,
    PaymentProviderFactory,

    // ── the money primitives ────────────────────────────────────────────────
    // Order here is documentation, not wiring: everything above the saga is something the saga
    // needs to be correct, and everything below it is a consequence of the saga running.
    LedgerService,
    IdempotencyService,
    LimitService,
    FxService,

    // ── who may be paid ─────────────────────────────────────────────────────
    UpiHandleService,
    PayeeScreeningService,
    BeneficiaryService,
    PaymentRiskService,

    // ── the saga and its compensations ──────────────────────────────────────
    TransferOrchestratorService,
    ReversalService,
    ReconciliationService,

    // ── the UPI flows ───────────────────────────────────────────────────────
    CollectService,
    MandateService,
    QrService,
    DisputeService,
    WalletService,

    // ── the safety nets ─────────────────────────────────────────────────────
    RailEventService,
    PaymentSchedulerService,
    /**
     * The M6 seam that lets an analyst release a `RISK_HELD` transfer.
     *
     * Registers itself into M6's `RiskActionRegistry` on init, so the dependency points
     * M4 → M6 only. The alternative — M6 injecting `TransferOrchestratorService` — is a
     * circular module reference, and `forwardRef` would defer the failure to runtime,
     * surfacing as an undefined injection while an analyst releases somebody's money.
     */
    PaymentRiskActionAdapter,

    // ── oversight ───────────────────────────────────────────────────────────
    PaymentsAdminService,

    JwtStrategy,
  ],
  /**
   * M5 settles insurance premiums through these, rather than through a second ledger.
   *
   * Exported as SERVICES, not as the Prisma models: the invariants live in `post`, `create` and
   * `applyRailOutcome`, and a module that wrote `LedgerEntry` rows directly would bypass every
   * one of them while appearing to reuse the ledger.
   */
  exports: [
    LedgerService,
    TransferOrchestratorService,
    ReconciliationService,
    WalletService,
    /**
     * Exported so M5 replays a premium payment through the SAME idempotency store this module uses.
     *
     * It was provided but not exported, which broke DI for `InsuranceController` and took the whole
     * application down at boot — a missing export is a startup failure, not a degraded feature.
     *
     * Sharing the one instance is also the only correct answer on the merits. Idempotency is enforced
     * by a unique index on `(userId, scope, key)`, and a premium debit retried after a dropped
     * response must replay the first result rather than charge twice. A second, locally-provided
     * instance would hit the same table and mostly work — which is worse than failing, because the
     * `IDEMPOTENCY_SCOPE` constants would then be maintained in two places and the first divergence
     * would be a double charge.
     */
    IdempotencyService,
  ],
})
export class PaymentsModule {}
