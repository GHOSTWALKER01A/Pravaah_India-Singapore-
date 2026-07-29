import { Module } from '@nestjs/common'
import { PassportModule as NestPassportModule } from '@nestjs/passport'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'

import { AdminInsuranceController } from '@/modules/insurance/admin-insurance.controller'
import { ClaimsController } from '@/modules/insurance/claims.controller'
import { InsuranceController } from '@/modules/insurance/insurance.controller'
import { InsuranceWebhookController } from '@/modules/insurance/insurance-webhook.controller'
import { MockInsurerController } from '@/modules/insurance/mock-insurer.controller'

import { DevOcrProvider } from '@/modules/insurance/providers/dev-ocr.provider'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import { MockHcxProvider } from '@/modules/insurance/providers/mock-hcx.provider'
import { MockInsurerProvider } from '@/modules/insurance/providers/mock-insurer.provider'

import { ClaimRiskActionAdapter } from '@/modules/insurance/services/claim-risk-action.adapter'
import { ClaimRiskService } from '@/modules/insurance/services/claim-risk.service'
import { ClaimsService } from '@/modules/insurance/services/claims.service'
import { InsuranceAdminService } from '@/modules/insurance/services/insurance-admin.service'
import { InsuranceLifecycleService } from '@/modules/insurance/services/insurance-lifecycle.service'
import { InsuranceMoneyService } from '@/modules/insurance/services/insurance-money.service'
import { PolicyService } from '@/modules/insurance/services/policy.service'
import { PremiumService } from '@/modules/insurance/services/premium.service'
import { QuotingService } from '@/modules/insurance/services/quoting.service'
import { UnderwritingService } from '@/modules/insurance/services/underwriting.service'

import { FraudModule } from '@/modules/fraud/fraud.module'
import { PaymentsModule } from '@/modules/payments/payments.module'

/**
 * M5 — Micro-Insurance (usage-based cover · reputation-priced · claims).
 *
 * M4 proved the platform can move money safely. M5 proves the reputation is worth more
 * than one product: the SAME consented behaviour (M1) and the SAME explainable score (M2)
 * price micro-insurance for a population insurers currently price blindly or refuse
 * outright — then sell a policy, collect premium over the M4 ledger, and run a claims
 * workflow with document verification and a fraud gate. One reputation, many products.
 * That is the claim, and this module is where it either holds or does not.
 *
 * ## What is genuinely ours, and what is not
 *
 * Pravaah is not, and in a 12-day build cannot be, an IRDAI-licensed insurer or
 * intermediary. Drawing that line explicitly is what makes the rest credible:
 *
 *  - **OURS, and real:** the underwriting decision priced off M2, the policy lifecycle,
 *    the anti-adverse-selection controls, the claims workflow with OCR and a fraud gate,
 *    and the MONEY — premiums and payouts post balanced entries to the same live
 *    double-entry ledger M4 built, and the loss ratio reconciles against its trial
 *    balance.
 *  - **THEIRS, and mocked:** binding the contract and carrying the risk.
 *    {@link MockInsurerProvider} answers deterministically behind
 *    {@link InsurerProvider}. Production is Acko, Digit or a sponsor insurer under a
 *    corporate-agent / Insurance Marketing Firm arrangement — a credential swap and one
 *    registry entry, not a rewrite.
 *  - **ROADMAP, behind interfaces that exist now:** HCX for interoperable health claims
 *    and ABDM/ABHA for health identity. {@link MockHcxProvider} reports itself
 *    UNCONFIGURED by default, so the exchange leg is visibly skipped rather than
 *    answering with a fabricated request id on a real claim.
 *
 * ## The four controls that keep the book solvent
 *
 * Adverse selection — only high-risk people buying — is the failure mode that closes
 * micro-insurance schemes. Each defence here is CODE rather than a UI hint:
 *
 *  1. **Behaviour-tied pricing.** EXCELLENT pays 0.70× what STANDARD pays for identical
 *     cover; POOR is declined with a route back to eligibility.
 *  2. **Waiting periods**, extended for higher-risk tiers. The control that makes
 *     buy-after-the-incident irrational, and the one the claims service enforces against
 *     the INCIDENT date rather than the filing date.
 *  3. **Coverage caps per tier** — the input the applicant chooses, and therefore the one
 *     that needs a server-side ceiling.
 *  4. **A confidence gate.** M2 reports honest uncertainty; thin data is priced
 *     conservatively rather than as though it were certain.
 *
 * ## Money safety, inherited rather than reimplemented
 *
 * Nothing in this module writes a `LedgerEntry`. {@link InsuranceMoneyService} is the only
 * file that touches money at all, and it does so through M4's exported services — so the
 * balance check under a row lock, the balanced-posting rule, the unique constraint that
 * makes a double credit a database error, and the reconciliation sweep all apply to an
 * insurance premium without being written twice. The premium and payout paths are
 * deliberately shaped as `reserve → settle` because M4's saga is the only state machine
 * that governs money here, and a status that lied about where the funds were is how a
 * reconciler comes to disagree with a ledger.
 *
 * Depends on M0 (a VERIFIED identity), M2 (a servable score — read through the Score table
 * with a freshness re-check, so a score whose consent has lapsed cannot price cover) and
 * M4 (the ledger, the transaction saga, idempotency). Feeds M6 — {@link ClaimRiskService}
 * is the fraud seam, wired and scoring — and M7, where a partner insurer verifies the
 * passport before underwriting.
 */
@Module({
  imports: [
    NestPassportModule,
    /**
     * M4, for the ledger and the transaction saga.
     *
     * Imported as a MODULE so M5 gets the exported services — `LedgerService`,
     * `TransferOrchestratorService` — rather than reaching for the Prisma models directly.
     * M4's own module comment is explicit about why: the invariants live in `post`,
     * `create` and `applyRailOutcome`, and a module writing ledger rows itself would
     * bypass every one of them while appearing to reuse the ledger.
     */
    PaymentsModule,
    /**
     * M6, for the risk engine behind the claims fraud gate.
     *
     * `ClaimRiskService` contributes the claims-domain signals and M6 adds the
     * cross-cutting layers — so a claim filed from a device bound minutes ago, on an
     * account inside a mule cluster, is now visible to claims scoring. Those are exactly
     * the signals a synthetic-identity ring produces, and M5 alone could not see any of
     * them.
     */
    FraudModule,
  ],
  controllers: [
    // Holder-facing (JWT).
    InsuranceController,
    ClaimsController,
    /**
     * Insurer callbacks — unauthenticated by session, verified by per-provider HMAC over
     * the raw bytes. Registered here but routed OUTSIDE the `insurance` prefix, so no
     * session guard can be inherited onto an endpoint a carrier calls without a JWT.
     */
    InsuranceWebhookController,
    /**
     * The mock insurer — the carrier's own side. Refused when NODE_ENV=production, because
     * these endpoints can produce a correctly signed callback that moves a claim's
     * recorded status, which is exactly the authority a real insurer has.
     */
    MockInsurerController,
    // Admin console (admin JWT + RBAC).
    AdminInsuranceController,
  ],
  providers: [
    // ── the providers ───────────────────────────────────────────────────────
    MockInsurerProvider,
    DevOcrProvider,
    MockHcxProvider,
    /**
     * Selection happens in a REGISTRY, not via `useClass: process.env.X === 'mock' ? …`.
     *
     * A ternary in this array is evaluated once, at module load, from `process.env`
     * directly — before `ConfigModule` has read the `.env.*.local` files this app loads. It
     * would silently select the mock in every environment whose mode came from a file
     * rather than the shell, and it could not REFUSE an unconfigured live provider.
     */
    InsuranceProviderRegistry,

    // ── the money bridge ────────────────────────────────────────────────────
    // First, because everything below it either collects a premium or pays a claim, and
    // this is the only file in M5 permitted to move money.
    InsuranceMoneyService,

    // ── price ───────────────────────────────────────────────────────────────
    UnderwritingService,
    QuotingService,

    // ── sell ────────────────────────────────────────────────────────────────
    PremiumService,
    PolicyService,

    // ── claim ───────────────────────────────────────────────────────────────
    ClaimRiskService,
    ClaimsService,
    /**
     * The M6 seam that lets a fraud analyst resolve a claim's case.
     *
     * Registers into M6's `RiskActionRegistry` on init, so the dependency points M5 → M6
     * only. Deliberately narrower than the payments adapter: clearing a case hands the
     * claim back to the adjudication queue rather than approving it, because approving
     * means paying out against remaining cover and that authority belongs to
     * `ClaimsService.decide`, not to a fraud analyst.
     */
    ClaimRiskActionAdapter,

    // ── oversight and the safety nets ───────────────────────────────────────
    InsuranceAdminService,
    InsuranceLifecycleService,

    JwtStrategy,
  ],
  /**
   * Exported for M6, which will read the claim risk signals, and for M7, where a partner
   * insurer's console needs the underwriting decision behind a policy.
   *
   * Exported as SERVICES rather than as the Prisma models, for the same reason M4 does it:
   * the waiting-period rule, the aggregate cover limit and the auto-approve condition live
   * in `ClaimsService` and `UnderwritingService`, and a module querying `Policy` directly
   * would bypass all three while appearing to reuse the module.
   */
  exports: [UnderwritingService, ClaimsService, InsuranceMoneyService],
})
export class InsuranceModule {}
