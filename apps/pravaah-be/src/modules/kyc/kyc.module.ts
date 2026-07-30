import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportModule } from '@nestjs/passport'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'
import { SupabaseModule } from '@/modules/database/supabase/supabase.module'

import { AdminAuthController } from '@/modules/kyc/admin/admin-auth.controller'
import { AdminAuthService } from '@/modules/kyc/admin/admin-auth.service'
import { AdminKycController } from '@/modules/kyc/admin/admin-kyc.controller'
import { ReviewEventsService } from '@/modules/kyc/admin/review-events.service'
import { ReviewService } from '@/modules/kyc/admin/review.service'
import { KycController } from '@/modules/kyc/kyc.controller'
import { MockDigilockerController } from '@/modules/kyc/mock-digilocker.controller'
import { MockSingpassController } from '@/modules/kyc/mock-singpass.controller'
import { BIOMETRICS } from '@/modules/kyc/providers/biometrics/biometrics.provider'
import { DevBiometricsProvider } from '@/modules/kyc/providers/biometrics/dev-biometrics.provider'
import { DecentroProvider } from '@/modules/kyc/providers/india/decentro.provider'
import { DevIndiaKycProvider } from '@/modules/kyc/providers/india/dev-india-kyc.provider'
import { Ok } from '@/common/result/result'
import {
  INDIA_KYC,
  type IndiaKycProvider,
} from '@/modules/kyc/providers/india/india-kyc.provider'
import { SG_KYC } from '@/modules/kyc/providers/singapore/singapore-kyc.provider'
import { SingpassPersonaProvider } from '@/modules/kyc/providers/singapore/singpass-persona.provider'
import { AadhaarOkycService } from '@/modules/kyc/services/aadhaar-okyc.service'
import { BankVerifyService } from '@/modules/kyc/services/bank-verify.service'
import { BiometricsService } from '@/modules/kyc/services/biometrics.service'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'
import { KycPollerService } from '@/modules/kyc/services/kyc-poller.service'
import { NameMatchService } from '@/modules/kyc/services/name-match.service'
import { PanService } from '@/modules/kyc/services/pan.service'
import { SanctionsService } from '@/modules/kyc/services/sanctions.service'
import { SingpassService } from '@/modules/kyc/services/singpass.service'
import { KycWebhookController } from '@/modules/kyc/webhook.controller'

@Module({
  imports: [PassportModule, SupabaseModule],
  controllers: [
    KycController,
    AdminAuthController,
    AdminKycController,
    KycWebhookController,
    MockSingpassController,
    MockDigilockerController,
  ],
  providers: [
    DecentroProvider,
    DevIndiaKycProvider,
    {
      provide: INDIA_KYC,
      /**
       * The India rail, with ONE seam: penny-drop can be simulated while PAN and
       * DigiLocker stay live.
       *
       * That seam exists because a vendor can block a single check and strand
       * the whole rail. Decentro's account validation needs a funded
       * commission-debit account configured on their side; until it is, step 3
       * refuses every request and no user can reach VERIFIED. The alternative
       * was flipping the entire rail to the mock, which throws away two working
       * live integrations AND replaces the real verified name with the demo
       * persona — corrupting the very field the passport is built from.
       *
       * `KYC_INDIA_BANK_PROVIDER=dev` simulates just the bank check. Unset, it
       * follows `KYC_INDIA_PROVIDER`, so the default behaviour is unchanged.
       */
      useFactory: (
        config: ConfigService,
        live: DecentroProvider,
        dev: DevIndiaKycProvider,
      ): IndiaKycProvider => {
        const mode =
          config.get<string>('KYC_INDIA_PROVIDER') ??
          (config.get<string>('NODE_ENV') === 'production' ? 'live' : 'dev')
        const base = mode === 'live' ? live : dev

        const bankMode = config.get<string>('KYC_INDIA_BANK_PROVIDER') ?? mode
        const bank = bankMode === 'live' ? live : dev
        if (bank === base) return base

        return {
          id: base.id,
          verifyPan: (pan, traceId) => base.verifyPan(pan, traceId),
          initiateOkyc: (userRef, traceId) =>
            base.initiateOkyc(userRef, traceId),
          fetchOkyc: (ref, traceId, code) => base.fetchOkyc(ref, traceId, code),
          /**
           * The simulated result contributes NO name.
           *
           * The mock returns its demo persona, and dropping that into a profile
           * whose other names came from the real income-tax and DigiLocker
           * records would collapse the name-match score and send a genuinely
           * consistent identity to manual review. A simulated penny-drop proves
           * nothing about the name, so it asserts nothing: reconciliation
           * ignores checks with no `extractedName`, leaving PAN and Aadhaar to
           * agree on their own.
           */
          pennyDrop: async (accountNumber, ifsc, traceId) => {
            const result = await bank.pennyDrop(accountNumber, ifsc, traceId)
            return result.ok
              ? Ok({
                  ...result.value,
                  registeredName: '',
                  // Recorded against the check, so a simulated pass is never
                  // mistaken for a real penny drop after the fact.
                  provider: bank.id,
                })
              : result
          },
        }
      },
      inject: [ConfigService, DecentroProvider, DevIndiaKycProvider],
    },
    SingpassPersonaProvider,
    { provide: SG_KYC, useExisting: SingpassPersonaProvider }, // → RealSingpassProvider
    { provide: BIOMETRICS, useClass: DevBiometricsProvider }, // → HyperVergeProvider

    // orchestration + checks
    KycOrchestratorService,
    NameMatchService,
    PanService,
    AadhaarOkycService,
    BankVerifyService,
    SingpassService,
    BiometricsService,
    SanctionsService,
    ReviewService,
    ReviewEventsService,
    AdminAuthService,
    KycPollerService,
    JwtStrategy,
  ],
  exports: [KycOrchestratorService],
})
export class KycModule {}
