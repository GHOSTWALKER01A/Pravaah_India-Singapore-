import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { SelectPersonaSchema, type SelectPersonaDto } from '@pravaah/schema'

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { SingpassPersonaProvider } from '@/modules/kyc/providers/singapore/singpass-persona.provider'

/**
 * Dev-only stand-in for the Singpass consent screen. The persona
 * `authorizationUrl` from `singpass/initiate` points here; a tester lists the
 * official personas (GET) then selects one (POST), which binds the persona to
 * the session so `singpass/callback` can fetch it. Replaced wholesale by the
 * real Singpass redirect when `RealSingpassProvider` is wired.
 */
@Controller('kyc/singpass/mock')
export class MockSingpassController {
  private readonly logger: AppLogger

  constructor(
    private readonly persona: SingpassPersonaProvider,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockSingpassController.name })
  }

  @Get(':providerRefId')
  list(@Param('providerRefId') providerRefId: string) {
    return ResponseBuilder.success(
      { providerRefId, personas: this.persona.listPersonas() },
      'Select a test persona',
    )
  }

  @Post(':providerRefId')
  select(
    @Param('providerRefId') providerRefId: string,
    @Body(new ZodValidationPipe(SelectPersonaSchema)) dto: SelectPersonaDto,
  ) {
    const bound = this.persona.bindPersona(providerRefId, dto.uinfin)
    if (!bound) {
      throw new NotFoundException('Unknown persona UINFIN')
    }
    this.logger.info(`[${this.select.name}] Persona consent granted`, {
      providerRefId,
      uinfin: dto.uinfin,
    })
    return ResponseBuilder.success(
      { providerRefId, uinfin: dto.uinfin },
      'Persona consent granted',
    )
  }
}
