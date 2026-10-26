import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'

import { ApplyPartnerSchema, type ApplyPartnerDto } from '@pravaah/schema'

import { ClientIp } from '@/common/decorators/idempotency-key.decorator'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { PARTNER_ONBOARDING_ROUTES } from '@/modules/partner/partner.route'
import { PartnerRegistryService } from '@/modules/partner/services/partner-registry.service'

/**
 * Public partner onboarding — the one unauthenticated M7 write.
 *
 * Safe to leave open because an application grants NOTHING: the partner is created
 * PENDING_APPROVAL with an empty scope, and every capability arrives with an admin's
 * approval. Throttled hard per IP all the same, because an open form that writes
 * rows is a free way to fill a table.
 *
 * `ThrottlerGuard` is functional here because `ThrottlerModule` is `@Global()` and
 * registered once, in `PassportModule` — see the note there. It is NOT registered a
 * second time: a second `forRoot` would silently replace M3's limits.
 */
@Controller(PARTNER_ONBOARDING_ROUTES.BASE)
export class PartnerOnboardingController {
  constructor(private readonly registry: PartnerRegistryService) {}

  @Post(PARTNER_ONBOARDING_ROUTES.APPLY)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  async apply(
    @Body(new ZodValidationPipe(ApplyPartnerSchema)) dto: ApplyPartnerDto,
    @ClientIp() ipAddress: string | null,
  ) {
    const data = await this.registry.apply(dto, ipAddress)
    return ResponseBuilder.success(data, 'Application received')
  }
}
