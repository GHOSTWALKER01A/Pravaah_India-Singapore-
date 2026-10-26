import { Module } from '@nestjs/common'
import { PassportModule as NestPassportModule } from '@nestjs/passport'

import { PartnerApiKeyGuard } from '@/common/guards/partner-api-key.guard'
import { JwtStrategy } from '@/common/strategies/jwt.strategy'
import { FraudModule } from '@/modules/fraud/fraud.module'
import { PassportModule } from '@/modules/passport/passport.module'

import { AdminPartnerController } from '@/modules/partner/admin-partner.controller'
import { AdminTrustRegistryController } from '@/modules/partner/admin-trust-registry.controller'
import {
  PartnerConsoleGuard,
  PartnerRolesGuard,
} from '@/modules/partner/guards/partner-console.guard'
import { HolderSharesController } from '@/modules/partner/holder-shares.controller'
import { PartnerApiController } from '@/modules/partner/partner-api.controller'
import { PartnerConfig } from '@/modules/partner/partner.config'
import { PartnerConsoleController } from '@/modules/partner/partner-console.controller'
import { PartnerOnboardingController } from '@/modules/partner/partner-onboarding.controller'
import { ConsentReceiptService } from '@/modules/partner/services/consent-receipt.service'
import { PartnerApiKeyService } from '@/modules/partner/services/partner-api-key.service'
import { PartnerRegistryService } from '@/modules/partner/services/partner-registry.service'
import { PartnerSchedulerService } from '@/modules/partner/services/partner-scheduler.service'
import { PartnerTemplateService } from '@/modules/partner/services/partner-template.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import { PartnerUserService } from '@/modules/partner/services/partner-user.service'
import { PartnerVerificationService } from '@/modules/partner/services/partner-verification.service'
import { PartnerWebhookService } from '@/modules/partner/services/partner-webhook.service'
import { TrustRegistryService } from '@/modules/partner/services/trust-registry.service'
import { VerificationAbuseService } from '@/modules/partner/services/verification-abuse.service'
import { VerificationEventsService } from '@/modules/partner/services/verification-events.service'

/**
 * M7 — The Partner Console (the relying-party side · closes the loop).
 *
 * Every earlier module builds the USER's asset: a verified identity (M0), consented
 * data (M1), an explainable score (M2), a passport they own (M3). M7 is where that
 * asset produces value — a lender, insurer, employer or landlord asks for a
 * presentation, receives a cryptographically verified and MINIMAL answer, and makes
 * a decision. It is also the revenue surface: every successful verification is a
 * metered, billable event.
 *
 * What M7 deliberately does NOT do is build a second handshake. M3 already has a
 * complete, audited one — single-use nonces, audience-bound KB-JWTs, a CAS-locked
 * approval, a status-list check. M7 extends M3's own tables (`VerifierPartner`,
 * `VerifierRequest`) and hooks the handshake through `VerifierEventsRegistry`:
 *
 *   PassportModule ◄── PartnerModule ──► FraudModule
 *        │  (registry: observer registered in onModuleInit)
 *        └─ never imports M7
 *
 * so there is exactly one place a presentation is verified and one place a request
 * changes state, whoever is asking.
 *
 * Five surfaces, five authentication models — see `partner.route.ts`:
 *
 *   /partner          partner API key (server-to-server)      PartnerApiController
 *   /partner-console  console user session + role ladder      PartnerConsoleController
 *   /partners/apply   public, throttled                        PartnerOnboardingController
 *   /passport/shares  holder session                           HolderSharesController
 *   /admin/…          PRAVAAH admin + RBAC                     AdminPartner / AdminTrustRegistry
 *
 * `ThrottlerModule` is NOT imported here. It is `@Global()` and registered once, in
 * PassportModule; a second `forRoot` would silently replace M3's limits.
 */
@Module({
  imports: [NestPassportModule, PassportModule, FraudModule],
  controllers: [
    PartnerApiController,
    PartnerConsoleController,
    PartnerOnboardingController,
    HolderSharesController,
    AdminPartnerController,
    AdminTrustRegistryController,
  ],
  providers: [
    PartnerConfig,

    // lifecycle + access
    PartnerRegistryService,
    PartnerApiKeyService,
    PartnerUserService,
    TrustRegistryService,

    // the verification product
    PartnerVerificationService,
    PartnerTemplateService,
    VerificationAbuseService,

    // side effects of a verification — driven by M3's handshake events
    VerificationEventsService,
    ConsentReceiptService,
    PartnerUsageService,
    PartnerWebhookService,

    // safety nets
    PartnerSchedulerService,

    // guards
    PartnerApiKeyGuard,
    PartnerConsoleGuard,
    PartnerRolesGuard,
    JwtStrategy,
  ],
  exports: [TrustRegistryService, ConsentReceiptService],
})
export class PartnerModule {}
