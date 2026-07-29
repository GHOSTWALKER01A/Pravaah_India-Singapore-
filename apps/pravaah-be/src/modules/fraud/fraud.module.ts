import { Module } from '@nestjs/common'
import { PassportModule as NestPassportModule } from '@nestjs/passport'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'

import { AnalystController } from '@/modules/fraud/analyst.controller'
import { FraudController } from '@/modules/fraud/fraud.controller'
import { FraudWebhookController } from '@/modules/fraud/fraud-webhook.controller'
import { MockTelcoController } from '@/modules/fraud/mock-telco.controller'

import { DevTelcoProvider } from '@/modules/fraud/providers/dev-telco.provider'
import { FraudProviderRegistry } from '@/modules/fraud/providers/fraud-provider.registry'

import { BehaviourService } from '@/modules/fraud/services/behaviour.service'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { FraudCaseService } from '@/modules/fraud/services/fraud-case.service'
import { FraudSchedulerService } from '@/modules/fraud/services/fraud-scheduler.service'
import { MuleGraphService } from '@/modules/fraud/services/mule-graph.service'
import { PinService } from '@/modules/fraud/services/pin.service'
import { RiskActionRegistry } from '@/modules/fraud/services/risk-action.registry'
import { RiskService } from '@/modules/fraud/services/risk.service'
import { StepUpService } from '@/modules/fraud/services/step-up.service'
import { VelocityService } from '@/modules/fraud/services/velocity.service'
import { WatchlistService } from '@/modules/fraud/services/watchlist.service'

/**
 * M6 — Fraud & Risk (the cross-cutting shield).
 *
 * Every other module DOES something valuable: verify an identity, pull consented data,
 * score reputation, mint a passport, move money, sell cover. M6 is the module that keeps
 * all of it safe. It is not a screen a user visits; it is a cross-cutting service the
 * other modules call at their decision points, plus an analyst console and a set of
 * background detectors. Its job is to answer one question, fast and explainably, at every
 * sensitive moment: *given everything we know about this user, this device, this network
 * and this action — allow, challenge, hold, or block?*
 *
 * ## The load-bearing idea: layered defence
 *
 * UPI keeps fraud below roughly 0.01% of a multi-trillion-rupee flow not through one
 * silver bullet but through independent layers that each fail safe. M6 mirrors that. Five
 * collectors run in parallel and none is load-bearing:
 *
 *  - **Device** — binding, SIM-swap anchor, cooling-off, integrity.
 *  - **Velocity** — bucketed rolling counters per dimension.
 *  - **Behaviour** — per-user amount baseline, active hours, geo-velocity.
 *  - **Graph** — cached mule/cluster scores from the async component job.
 *  - **Lists** — watch, block, mule, sanctions.
 *
 * Defeating one does not defeat the system. If the graph store is empty, velocity and
 * device signals still decide; if the telco is down, the stored SIM anchor still
 * compares; if a collector THROWS, `Promise.allSettled` records the failure as a signal
 * and the rest still decide. Every layer degrades to a stricter decision, never to
 * `ALLOW` — which is what "fails safe" has to mean in code rather than on a slide.
 *
 * ## What is genuinely ours, and what is not
 *
 * Drawing that line explicitly is what makes the rest credible:
 *
 *  - **OURS, and real:** the decision engine (noisy-OR aggregation, the four-band ladder,
 *    the hard-signal bypass), the device-binding lifecycle and SIM-anchor comparison, the
 *    velocity counters, the behavioural baselines, the connected-components mule graph,
 *    the step-up state machine with nonce/attempt/expiry/purpose binding, and the full
 *    analyst case workflow with its release path and audit trail.
 *  - **THEIRS, and stubbed:** the authoritative answer to "was this number re-issued".
 *    A real telco SIM-swap API, NPCI's SIM-Binding-Certificate handshake or GSMA Open
 *    Gateway all need a commercial agreement. {@link DevTelcoProvider} answers
 *    deterministically behind {@link TelcoProvider}. **Crucially, the swap DETECTION does
 *    not depend on it** — the anchor comparison is against a serial WE stored, so the
 *    control works with a stub behind it and the carrier is corroboration rather than the
 *    mechanism.
 *  - **ROADMAP, honestly labelled:** biometric step-up verifies an app-level assertion,
 *    not a hardware-backed WebAuthn signature. That limitation is why
 *    `DEVICE_INTEGRITY` carries a 0.45 weight — the two controls cover each other.
 *
 * ## Privacy-preserving by construction
 *
 * Every cross-user artefact is stored as a keyed HMAC, never plaintext (see
 * `risk-hash.util.ts`). The mule graph can establish that three accounts share a device
 * without the table recording which device; the blocklist can match a VPA without holding
 * a readable list of suspected criminals. An HMAC rather than a bare sha256, because a
 * VPA or a ten-digit mobile number is brute-forceable in minutes otherwise — the hash
 * would have been decorative for exactly the identifiers that matter most.
 *
 * ## Where it plugs in, and why the dependency points this way
 *
 * M6 imports NOTHING from M0/M1/M4/M5. They import it. That direction is deliberate: the
 * shield cannot depend on the things it protects, or a change to the payment saga becomes
 * a change to the fraud engine.
 *
 * The one place the arrow needs to reverse — an analyst clearing a case must RELEASE M4's
 * held transaction — goes through {@link RiskActionRegistry}, an inversion-of-control
 * seam that downstream modules register into at `onModuleInit`. A direct dependency there
 * would be a circular module reference, and NestJS's `forwardRef` escape hatch resolves at
 * runtime, so a mistake would surface as an undefined injection deep inside a case
 * resolution rather than at startup.
 *
 * Depends on nothing but Prisma, the audit trail and the SMS channel.
 */
@Module({
  imports: [NestPassportModule],
  controllers: [
    // User-facing (JWT): device management, step-up, transparency.
    FraudController,
    /**
     * Telco callbacks — unauthenticated by session, verified by HMAC over the raw bytes.
     * Registered here but routed OUTSIDE the `security` prefix, so no session guard can be
     * inherited onto an endpoint a carrier calls without a JWT.
     */
    FraudWebhookController,
    /**
     * The mock telco — the carrier's own side. Refused when `NODE_ENV=production`, because
     * these endpoints can produce a correctly signed callback that FREEZES a user's
     * devices, which is exactly the authority a real carrier has.
     */
    MockTelcoController,
    // The analyst console (admin JWT + RBAC).
    AnalystController,
  ],
  providers: [
    // ── the provider, behind a registry ─────────────────────────────────────
    DevTelcoProvider,
    /**
     * Selection happens in a REGISTRY, not via `useClass: process.env.X === 'dev' ? …`.
     *
     * A ternary in this array is evaluated once, at module load, from `process.env`
     * directly — before `ConfigModule` has read the `.env.*.local` files this app loads.
     * It would silently select the dev provider in every environment whose mode came from
     * a file rather than the shell, and it could not REFUSE an unconfigured live carrier.
     */
    FraudProviderRegistry,

    // ── the release seam ────────────────────────────────────────────────────
    // First, because downstream modules register into it during their own init and it
    // must exist before they do.
    RiskActionRegistry,

    // ── the signal collectors ───────────────────────────────────────────────
    DeviceTrustService,
    VelocityService,
    BehaviourService,
    MuleGraphService,
    WatchlistService,

    // ── the engine ──────────────────────────────────────────────────────────
    RiskService,

    // ── the responses to a decision ─────────────────────────────────────────
    PinService,
    StepUpService,
    FraudCaseService,

    // ── background work ─────────────────────────────────────────────────────
    FraudSchedulerService,

    JwtStrategy,
  ],
  /**
   * Exported as SERVICES rather than as the Prisma models, for the same reason M4 and M5
   * do it: the aggregation rule, the decision ladder, the hard-signal bypass and the
   * device lifecycle live in these classes, and a module querying `RiskAssessment` or
   * `Device` directly would bypass every one of them while appearing to reuse M6.
   *
   *  - `RiskService` — M4, M5, M1 and Auth call it at their decision points.
   *  - `StepUpService` — M4 needs `hasPassed` to let a stepped-up transfer proceed.
   *  - `DeviceTrustService` — M0 binds devices; M4 resolves a device for scoring.
   *  - `VelocityService` — Auth records login attempts.
   *  - `MuleGraphService` — M4 reports a new beneficiary as a graph edge.
   *  - `RiskActionRegistry` — M4 and M5 register their release adapters.
   */
  exports: [
    RiskService,
    PinService,
    StepUpService,
    DeviceTrustService,
    VelocityService,
    MuleGraphService,
    RiskActionRegistry,
  ],
})
export class FraudModule {}
