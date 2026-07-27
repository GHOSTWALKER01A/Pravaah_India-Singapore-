import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  ServiceUnavailableException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileFieldsInterceptor } from '@nestjs/platform-express'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  LivenessVerifySchema,
  OkycCallbackSchema,
  PennyDropSchema,
  PushTokenSchema,
  ScreenSanctionsSchema,
  SingpassCallbackSchema,
  StartKycSchema,
  VerifyPanSchema,
  type LivenessVerifyDto,
  type OkycCallbackDto,
  type PennyDropDto,
  type PushTokenDto,
  type ScreenSanctionsDto,
  type SingpassCallbackDto,
  type StartKycDto,
  type VerifyPanDto,
} from '@pravaah/schema'

import { User, type AuthenticatedUser } from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { KYC_ROUTES } from '@/modules/kyc/kyc.route'
import { AadhaarOkycService } from '@/modules/kyc/services/aadhaar-okyc.service'
import { BankVerifyService } from '@/modules/kyc/services/bank-verify.service'
import { BiometricsService } from '@/modules/kyc/services/biometrics.service'
import { KycOrchestratorService } from '@/modules/kyc/services/kyc-orchestrator.service'
import { PanService } from '@/modules/kyc/services/pan.service'
import { SanctionsService } from '@/modules/kyc/services/sanctions.service'
import { SingpassService } from '@/modules/kyc/services/singpass.service'

type UploadedFile = { buffer: Buffer }

// Validation pipe is bound to @Body() specifically — a method-level @UsePipes
// would also run against @User()/@Param() and reject them.
@Controller(KYC_ROUTES.BASE)
@UseGuards(AuthGuard)
export class KycController {
  private readonly logger: AppLogger

  constructor(
    private readonly orchestrator: KycOrchestratorService,
    private readonly pan: PanService,
    private readonly okyc: AadhaarOkycService,
    private readonly bank: BankVerifyService,
    private readonly singpass: SingpassService,
    private readonly bio: BiometricsService,
    private readonly sanctions: SanctionsService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: KycController.name })
  }

  @Post(KYC_ROUTES.START)
  async start(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(StartKycSchema)) dto: StartKycDto,
  ) {
    this.logger.info(`[${this.start.name}] Starting KYC`, {
      userId: user.id,
      country: dto.country,
    })
    await this.orchestrator.startKyc({
      supabaseUserId: user.id,
      phone: user.phone,
      email: user.email,
      country: dto.country,
    })
    const data = await this.orchestrator.getProfileStatus(user.id)
    return ResponseBuilder.success(data, 'KYC started')
  }

  @Get(KYC_ROUTES.STATUS)
  async status(@User() user: AuthenticatedUser) {
    const userId = await this.orchestrator.resolveUserId(user.id)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'KYC status')
  }

  @Post(KYC_ROUTES.PUSH_TOKEN)
  async registerPushToken(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PushTokenSchema)) dto: PushTokenDto,
  ) {
    await this.orchestrator.setPushToken({
      supabaseUserId: user.id,
      phone: user.phone,
      email: user.email,
      token: dto.token,
    })
    return ResponseBuilder.success({ ok: true }, 'Push token registered')
  }

  @Post(KYC_ROUTES.PAN_VERIFY)
  async verifyPan(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(VerifyPanSchema)) dto: VerifyPanDto,
  ) {
    // Never log the PAN itself — only that a verification was requested.
    this.logger.info(`[${this.verifyPan.name}] Verifying PAN`, {
      userId: user.id,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    await this.pan.verify(userId, dto.pan)
    // Return the refreshed canonical status (the check outcome is reflected in
    // its `checks[]`), so the app renders from one shape everywhere.
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'PAN verification processed')
  }

  @Post(KYC_ROUTES.OKYC_INITIATE)
  async okycInitiate(@User() user: AuthenticatedUser) {
    this.logger.info(`[${this.okycInitiate.name}] Initiating DigiLocker`, {
      userId: user.id,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    const data = await this.okyc.initiate(userId)
    // A failed init has no authorizationUrl to hand back — surface it as a 503
    // rather than a 201 that the client has to introspect for `ok:false`.
    if (!data.ok) {
      throw new ServiceUnavailableException(data.reason)
    }
    return ResponseBuilder.success(data, 'DigiLocker session initiated')
  }

  @Post(KYC_ROUTES.OKYC_CALLBACK)
  async okycCallback(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(OkycCallbackSchema)) dto: OkycCallbackDto,
  ) {
    this.logger.info(`[${this.okycCallback.name}] Completing DigiLocker`, {
      userId: user.id,
      providerRefId: dto.providerRefId,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    await this.okyc.complete(userId, dto.providerRefId)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'DigiLocker fetch processed')
  }

  @Post(KYC_ROUTES.BANK_PENNY_DROP)
  async pennyDrop(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PennyDropSchema)) dto: PennyDropDto,
  ) {
    // Never log the account number.
    this.logger.info(`[${this.pennyDrop.name}] Verifying bank account`, {
      userId: user.id,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    await this.bank.verify(userId, dto.account, dto.ifsc, dto.cardValidity)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'Penny-drop processed')
  }

  @Post(KYC_ROUTES.SINGPASS_INITIATE)
  async singpassInitiate(@User() user: AuthenticatedUser) {
    this.logger.info(`[${this.singpassInitiate.name}] Initiating Singpass`, {
      userId: user.id,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    const data = await this.singpass.initiate(userId)
    return ResponseBuilder.success(data, 'Singpass session initiated')
  }

  @Post(KYC_ROUTES.SINGPASS_CALLBACK)
  async singpassCallback(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SingpassCallbackSchema))
    dto: SingpassCallbackDto,
  ) {
    this.logger.info(`[${this.singpassCallback.name}] Completing Singpass`, {
      userId: user.id,
      providerRefId: dto.providerRefId,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    await this.singpass.complete(userId, dto.providerRefId)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'Singpass fetch processed')
  }

  @Post(KYC_ROUTES.LIVENESS_SESSION)
  async livenessSession(@User() user: AuthenticatedUser) {
    const userId = await this.orchestrator.resolveUserId(user.id)
    const data = await this.bio.startLiveness(userId)
    return ResponseBuilder.success(data, 'Liveness session started')
  }

  @Post(KYC_ROUTES.LIVENESS_VERIFY)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'selfie', maxCount: 1 }]))
  async livenessVerify(
    @User() user: AuthenticatedUser,
    @UploadedFiles() files: { selfie?: UploadedFile[] },
    @Body(new ZodValidationPipe(LivenessVerifySchema)) dto: LivenessVerifyDto,
  ) {
    this.logger.info(`[${this.livenessVerify.name}] Verifying liveness`, {
      userId: user.id,
      sessionId: dto.sessionId,
    })
    const selfie = files?.selfie?.[0]?.buffer
    // A liveness attempt without a captured frame can't be verified — reject it
    // up front rather than letting a provider silently pass an empty payload.
    if (!selfie?.length) {
      throw new BadRequestException('A captured selfie frame is required')
    }
    const userId = await this.orchestrator.resolveUserId(user.id)
    await this.bio.verifyLiveness(userId, dto.sessionId, selfie, dto.challenge)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'Liveness verification processed')
  }

  @Post(KYC_ROUTES.FACE_MATCH)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'selfie', maxCount: 1 },
      { name: 'idPhoto', maxCount: 1 },
    ]),
  )
  async faceMatch(
    @User() user: AuthenticatedUser,
    @UploadedFiles()
    files: { selfie?: UploadedFile[]; idPhoto?: UploadedFile[] },
  ) {
    this.logger.info(`[${this.faceMatch.name}] Matching face`, {
      userId: user.id,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    const selfie = files?.selfie?.[0]?.buffer
    const idPhoto = files?.idPhoto?.[0]?.buffer
    // Both images are mandatory — an empty/absent file would silently "pass" a
    // real provider check, so reject it up front.
    if (!selfie?.length || !idPhoto?.length) {
      throw new BadRequestException(
        'Both selfie and idPhoto image files are required',
      )
    }
    await this.bio.faceMatch(userId, selfie, idPhoto)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'Face match processed')
  }

  @Post(KYC_ROUTES.SANCTIONS_SCREEN)
  async screenSanctions(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ScreenSanctionsSchema)) dto: ScreenSanctionsDto,
  ) {
    this.logger.info(`[${this.screenSanctions.name}] Screening sanctions`, {
      userId: user.id,
    })
    const userId = await this.orchestrator.resolveUserId(user.id)
    await this.sanctions.screenCurrent(userId, dto.name)
    const data = await this.orchestrator.getProfileStatus(userId)
    return ResponseBuilder.success(data, 'Sanctions screening processed')
  }
}
