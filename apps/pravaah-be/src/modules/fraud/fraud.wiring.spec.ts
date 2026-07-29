import { Test, type TestingModule } from '@nestjs/testing'

import { AppModule } from '@/app.module'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { FraudProviderRegistry } from '@/modules/fraud/providers/fraud-provider.registry'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { FraudCaseService } from '@/modules/fraud/services/fraud-case.service'
import { MuleGraphService } from '@/modules/fraud/services/mule-graph.service'
import { RiskActionRegistry } from '@/modules/fraud/services/risk-action.registry'
import { RiskService } from '@/modules/fraud/services/risk.service'
import { StepUpService } from '@/modules/fraud/services/step-up.service'
import { VelocityService } from '@/modules/fraud/services/velocity.service'
import { WatchlistService } from '@/modules/fraud/services/watchlist.service'
import { ClaimRiskService } from '@/modules/insurance/services/claim-risk.service'
import { PaymentRiskService } from '@/modules/payments/services/payment-risk.service'

import { RiskSubjectType } from 'generated/prisma/client'

/**
 * Does the dependency graph actually resolve?
 *
 * ## Why this test exists, and why nothing else covers it
 *
 * Every M6 service typechecks in isolation, and 105 unit tests pass, and none of that
 * proves the application starts. Nest resolves providers at BOOT: a service that is
 * `provided` but not `exported`, or injected across a module boundary that does not
 * `import` its owner, fails there — and a missing export is a TOTAL startup failure, not a
 * degraded feature. M4's own module comment records exactly this happening with
 * `IdempotencyService`, which "took the whole application down at boot".
 *
 * M6 raises the stakes because it INVERTS a dependency. `RiskActionRegistry` is populated
 * by adapters living in M4 and M5, during their own `onModuleInit`. Nothing in the type
 * system checks that those adapters are registered — and if they are not, an analyst
 * clearing a fraud case gets "no release handler", the held money stays held, and the case
 * closes reporting success. That is the failure this file is here to catch.
 *
 * ## Why Prisma is mocked rather than connected
 *
 * `PrismaService.onModuleInit` opens a real connection. The point here is the WIRING, not
 * the database, and a test that needed a reachable Postgres would not run in CI — so it
 * would be deleted, and the wiring would go unchecked. The mock is deliberately empty:
 * nothing in this test calls a query.
 */
describe('M6 wiring', () => {
  let moduleRef: TestingModule

  beforeAll(async () => {
    /**
     * `DATABASE_URL` must merely be PRESENT — `PrismaService`'s constructor throws without
     * it, before the override can take effect, because the override replaces the provider
     * and Nest still constructs the module's own `ConfigService` chain.
     */
    process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/test'
    process.env.RISK_HASH_KEY ??= 'test-risk-hash-key'
    process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-long-enough-to-pass'

    /**
     * The REAL `AppModule`, with only Prisma replaced.
     *
     * Importing `FraudModule` plus `PaymentsModule` plus `InsuranceModule` directly would
     * be the narrower test and it is the wrong one twice over: it cannot supply the global
     * providers those modules need (`APP_LOGGER`, `AuditService`, the cache), and — more
     * importantly — it would prove that a hand-assembled graph resolves rather than that
     * the ACTUAL application graph does. The bug being guarded against is a module missing
     * from `AppModule`'s imports, which only the real thing can catch.
     */
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile()

    /**
     * `init()` is what runs `onModuleInit`. Without it the module compiles and the registry
     * stays empty — so this line is the entire point of the test.
     */
    await moduleRef.init()
  })

  afterAll(async () => {
    await moduleRef?.close()
  })

  describe('M6 services resolve', () => {
    it.each([
      ['RiskService', RiskService],
      ['DeviceTrustService', DeviceTrustService],
      ['VelocityService', VelocityService],
      ['MuleGraphService', MuleGraphService],
      ['WatchlistService', WatchlistService],
      ['StepUpService', StepUpService],
      ['FraudCaseService', FraudCaseService],
      ['RiskActionRegistry', RiskActionRegistry],
    ])('%s', (_label, token) => {
      expect(moduleRef.get(token)).toBeDefined()
    })
  })

  describe('downstream modules got M6 injected', () => {
    /**
     * If this resolves, `PaymentsModule` imported `FraudModule` AND `FraudModule` exported
     * `RiskService` — which together are the whole delegation. It is a one-line test for a
     * two-file contract.
     */
    it('PaymentRiskService (M4 → M6)', () => {
      expect(moduleRef.get(PaymentRiskService)).toBeDefined()
    })

    it('ClaimRiskService (M5 → M6)', () => {
      expect(moduleRef.get(ClaimRiskService)).toBeDefined()
    })
  })

  /**
   * The inverted dependency. The assertion no type check and no other test can make.
   */
  describe('release handlers are registered by downstream adapters', () => {
    it.each([
      RiskSubjectType.TRANSACTION,
      RiskSubjectType.PAYOUT,
      RiskSubjectType.CLAIM,
    ])('%s has a handler', (subjectType) => {
      const registry = moduleRef.get(RiskActionRegistry)
      expect(registry.has(subjectType)).toBe(true)
    })

    /**
     * A subject type with no handler must be a soft no-op, not a throw. LOGIN and
     * DEVICE_BIND cases have no held money to release, and a registry that threw would make
     * every such case permanently unresolvable.
     */
    it('reports a missing handler without throwing', async () => {
      const registry = moduleRef.get(RiskActionRegistry)

      expect(registry.has(RiskSubjectType.LOGIN)).toBe(false)

      const result = await registry.apply({
        subjectType: RiskSubjectType.LOGIN,
        subjectId: 'login:abc',
        userId: 'user-1',
        outcome: 'RELEASE',
        reason: 'cleared',
      })

      expect(result.applied).toBe(false)
      expect(result.detail).toContain('LOGIN')
    })

    /**
     * A handler that throws is captured as `applied: false`, never propagated. A case
     * resolution must record the analyst's DECISION even when the downstream release fails
     * — the judgement was made by a human and must not be lost because a transaction had
     * meanwhile expired.
     */
    it('captures a throwing handler instead of propagating', async () => {
      const registry = moduleRef.get(RiskActionRegistry)

      registry.register(RiskSubjectType.CONSENT, {
        release: () => Promise.reject(new Error('downstream exploded')),
        block: () => Promise.reject(new Error('downstream exploded')),
      })

      const result = await registry.apply({
        subjectType: RiskSubjectType.CONSENT,
        subjectId: 'consent:1',
        userId: 'user-1',
        outcome: 'RELEASE',
        reason: 'cleared',
      })

      expect(result.applied).toBe(false)
      expect(result.detail).toBe('downstream exploded')
    })
  })

  describe('provider selection', () => {
    it('reports the telco provider it is actually running', () => {
      const described = moduleRef.get(FraudProviderRegistry).describe()

      expect(described.telco.mode).toBe('dev')
      expect(described.telco.configured).toBe(true)
      /**
       * Asserted FALSE on purpose. A build that quietly reported a dev stub as a live
       * carrier integration would discredit every other claim in the module.
       */
      expect(described.telco.live).toBe(false)
    })

    /**
     * A non-dev mode with no implementation must THROW rather than silently downgrade. An
     * operator who selected a real carrier and got the stub would believe SIM-swap
     * detection was corroborated when it was not.
     */
    it('refuses an unimplemented live telco rather than downgrading', () => {
      const registry = moduleRef.get(FraudProviderRegistry)
      const previous = process.env.TELCO_MODE

      try {
        process.env.TELCO_MODE = 'airtel'
        expect(() => registry.telco()).toThrow(/no live telco integration/i)
      } finally {
        if (previous === undefined) delete process.env.TELCO_MODE
        else process.env.TELCO_MODE = previous
      }
    })

    /**
     * An unknown provider name in a webhook URL is UNAUTHENTICATED input, so it must
     * resolve to `null` for a flat 403 rather than throwing into a 500 with a stack trace.
     */
    it('resolves an unknown webhook provider to null', () => {
      const registry = moduleRef.get(FraudProviderRegistry)

      expect(registry.telcoByName('dev-telco')).not.toBeNull()
      expect(registry.telcoByName('../../etc/passwd')).toBeNull()
    })
  })
})
