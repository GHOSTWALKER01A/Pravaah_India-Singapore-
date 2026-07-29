import { Module } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'

import { AaWebhookController } from '@/modules/consent/aa-webhook.controller'
import { AdminConsentController } from '@/modules/consent/admin-consent.controller'
import { ConsentController } from '@/modules/consent/consent.controller'
import { MockAaController } from '@/modules/consent/mock-aa.controller'
import { AaProviderRegistry } from '@/modules/consent/providers/aa/aa-registry'
import { FinvuAaProvider } from '@/modules/consent/providers/aa/finvu-aa.provider'
import { SandboxAaProvider } from '@/modules/consent/providers/aa/sandbox-aa.provider'
import { SetuAaProvider } from '@/modules/consent/providers/aa/setu-aa.provider'
import { ConsentNotificationService } from '@/modules/consent/services/consent-notification.service'
import { ConsentSchedulerService } from '@/modules/consent/services/consent-scheduler.service'
import { ConsentService } from '@/modules/consent/services/consent.service'
import { DataLifeService } from '@/modules/consent/services/data-life.service'
import { DataSessionService } from '@/modules/consent/services/data-session.service'
import { FiNormalizerService } from '@/modules/consent/services/fi-normalizer.service'
import { FraudModule } from '@/modules/fraud/fraud.module'

/**
 * M1 — Consent & Data Aggregation (Account Aggregator).
 *
 * Three interchangeable AA providers sit behind {@link AaProviderRegistry}:
 *  - SandboxAaProvider — in-memory mock (default, AA_MODE=sandbox)
 *  - SetuAaProvider    — Setu (live; AA_MODE=setu, or primary of AA_MODE=live)
 *  - FinvuAaProvider   — Finvu/Finsense (AA_MODE=finvu, or fallback of live)
 *
 * AA_MODE=live tries Setu then falls back to Finvu at consent-creation; the
 * winning provider is persisted on `Consent.aaProvider` and every later call
 * (session/fetch/revoke/status) routes back to it. The lifecycle, crypto,
 * normalisation and data-life logic never change — only the routing does.
 */
@Module({
  /**
   * M6, for consent-farming detection (T11) on the creation path.
   *
   * Automated bulk consent creation is how somebody harvests data or probes the AA rail at
   * scale, and it is invisible to the per-purpose duplicate check M1 already has — that
   * check stops the same purpose twice, not fifty different purposes from one device.
   */
  imports: [PassportModule, FraudModule],
  controllers: [
    ConsentController,
    AaWebhookController,
    AdminConsentController,
    MockAaController,
  ],
  providers: [
    SandboxAaProvider,
    SetuAaProvider,
    FinvuAaProvider,
    AaProviderRegistry,

    ConsentService,
    DataSessionService,
    FiNormalizerService,
    ConsentNotificationService,
    DataLifeService,
    ConsentSchedulerService,

    JwtStrategy,
  ],
  exports: [ConsentService],
})
export class ConsentModule {}
