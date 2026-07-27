import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { TokenService } from '@/modules/auth/token.service'
import { TwilioVerifyService } from '@/modules/auth/twilio-verify.service'

/**
 * Shared auth primitives — Twilio Verify (OTP) + session token issuance —
 * used by both the user AuthModule and the admin auth (in KycModule). Global so
 * either can inject them without cross-module imports.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [TwilioVerifyService, TokenService],
  exports: [TwilioVerifyService, TokenService],
})
export class AuthCoreModule {}
