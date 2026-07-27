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
import { INDIA_KYC } from '@/modules/kyc/providers/india/india-kyc.provider'
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
      useFactory: (
        config: ConfigService,
        live: DecentroProvider,
        dev: DevIndiaKycProvider,
      ) => {
        const mode =
          config.get<string>('KYC_INDIA_PROVIDER') ??
          (config.get<string>('NODE_ENV') === 'production' ? 'live' : 'dev')
        return mode === 'live' ? live : dev
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
