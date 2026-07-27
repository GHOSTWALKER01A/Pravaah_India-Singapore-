import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  RefreshTokenRequestSchema,
  SignInRequestSchema,
  VerifyRequestSchema,
  type RefreshTokenRequest,
  type SignInRequest,
  type VerifyRequest,
} from '@pravaah/schema'

import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import type { AdminUser } from 'generated/prisma/client'

import { ADMIN_AUTH_ROUTES } from '@/modules/kyc/kyc.route'
import { AdminAuthService } from '@/modules/kyc/admin/admin-auth.service'

@Controller(ADMIN_AUTH_ROUTES.BASE)
export class AdminAuthController {
  private readonly logger: AppLogger

  constructor(
    private readonly adminAuth: AdminAuthService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminAuthController.name })
  }

  @Post(ADMIN_AUTH_ROUTES.SEND_OTP)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(SignInRequestSchema))
  async sendOtp(@Body() request: SignInRequest) {
    this.logger.info(`[${this.sendOtp.name}] Admin OTP requested`)
    const data = await this.adminAuth.sendOtp(request)
    return ResponseBuilder.success(data, 'OTP sent successfully')
  }

  @Post(ADMIN_AUTH_ROUTES.RESEND_OTP)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(SignInRequestSchema))
  async resendOtp(@Body() request: SignInRequest) {
    const data = await this.adminAuth.sendOtp(request)
    return ResponseBuilder.success(data, 'OTP resent successfully')
  }

  @Post(ADMIN_AUTH_ROUTES.VERIFY_OTP)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(VerifyRequestSchema))
  async verifyOtp(@Body() request: VerifyRequest) {
    const data = await this.adminAuth.verifyOtp(request)
    return ResponseBuilder.success(data, 'Admin verified successfully')
  }

  @Post(ADMIN_AUTH_ROUTES.REFRESH_TOKEN)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(RefreshTokenRequestSchema))
  async refreshToken(@Body() request: RefreshTokenRequest) {
    const data = await this.adminAuth.refreshToken(request)
    return ResponseBuilder.success(data, 'Token refreshed successfully')
  }

  @Get(ADMIN_AUTH_ROUTES.ME)
  @UseGuards(AdminAuthGuard)
  me(@Req() req: { admin: AdminUser }) {
    return ResponseBuilder.success(
      this.adminAuth.toProfile(req.admin),
      'Current admin',
    )
  }
}
