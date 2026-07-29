import { Module } from '@nestjs/common'

import { AuthController } from '@/modules/auth/auth.controller'
import { AuthService } from '@/modules/auth/auth.service'
import { FraudModule } from '@/modules/fraud/fraud.module'

// TwilioVerifyService + TokenService come from the global AuthCoreModule;
// PrismaService from the global PrismaModule.
@Module({
  /**
   * M6, for credential-stuffing and ATO detection on the login path (T3, T2).
   *
   * `AuthService` uses `VelocityService` to record every attempt — success and failure —
   * and to refuse further attempts from a network showing a stuffing pattern. A bot
   * spraying leaked credentials mostly misses, so recording only successes would leave the
   * spray invisible.
   */
  imports: [FraudModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
