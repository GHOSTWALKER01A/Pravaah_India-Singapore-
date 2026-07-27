import { Module } from '@nestjs/common'

import { AuthController } from '@/modules/auth/auth.controller'
import { AuthService } from '@/modules/auth/auth.service'

// TwilioVerifyService + TokenService come from the global AuthCoreModule;
// PrismaService from the global PrismaModule.
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
