import { Body, Controller, HttpCode, Inject, Post, UsePipes } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  RefreshTokenRequestSchema,
  SignInRequestSchema,
  VerifyRequestSchema,
  type RefreshTokenRequest,
  type SignInRequest,
  type VerifyRequest,
} from '@pravaah/schema'

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { AUTH_ROUTES } from '@/modules/auth/auth.route'
import { AuthService } from '@/modules/auth/auth.service'

@Controller(AUTH_ROUTES.BASE)
export class AuthController {
  private readonly logger: AppLogger

  constructor(
    private readonly authService: AuthService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AuthController.name })
  }

  @Post(AUTH_ROUTES.SEND_OTP)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(SignInRequestSchema))
  async sendOtp(@Body() request: SignInRequest) {
    this.logger.info(`[${this.sendOtp.name}] Sending OTP`)
    const data = await this.authService.signInWithOtp(request)
    return ResponseBuilder.success(data, 'OTP sent successfully')
  }

  @Post(AUTH_ROUTES.RESEND_OTP)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(SignInRequestSchema))
  async resendOtp(@Body() request: SignInRequest) {
    this.logger.info(`[${this.resendOtp.name}] Resending OTP`)
    const data = await this.authService.signInWithOtp(request)
    return ResponseBuilder.success(data, 'OTP resent successfully')
  }

  @Post(AUTH_ROUTES.VERIFY_OTP)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(VerifyRequestSchema))
  async verifyOtp(@Body() request: VerifyRequest) {
    this.logger.info(`[${this.verifyOtp.name}] Verifying OTP`)
    const data = await this.authService.verifyOtp(request)
    return ResponseBuilder.success(data, 'OTP verified successfully')
  }

  @Post(AUTH_ROUTES.REFRESH_TOKEN)
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(RefreshTokenRequestSchema))
  async refreshToken(@Body() request: RefreshTokenRequest) {
    this.logger.info(`[${this.refreshToken.name}] Refreshing session`)
    const data = await this.authService.refreshToken(request)
    return ResponseBuilder.success(data, 'Token refreshed successfully')
  }
}
