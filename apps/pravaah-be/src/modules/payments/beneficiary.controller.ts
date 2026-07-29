import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AddBeneficiarySchema,
  BeneficiaryListQuerySchema,
  BlockBeneficiarySchema,
  ResolveMobileSchema,
  ResolveVpaSchema,
  type AddBeneficiaryDto,
  type BeneficiaryListQueryDto,
  type BlockBeneficiaryDto,
  type ResolveMobileDto,
  type ResolveVpaDto,
} from '@pravaah/schema'

import {
  User,
  type AuthenticatedUser,
} from '@/common/decorators/user.decorator'
import { AuthGuard } from '@/common/guards/auth.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { BENEFICIARY_ROUTES } from '@/modules/payments/payments.route'
import { BeneficiaryService } from '@/modules/payments/services/beneficiary.service'
import { LimitService } from '@/modules/payments/services/limit.service'
import { maskHandle } from '@/modules/payments/vpa.util'

import { BeneficiaryStatus, type Beneficiary } from 'generated/prisma/client'

/**
 * Payees.
 *
 * The `registeredName` is what this controller exists to surface. NPCI requires the name the
 * payee's BANK holds to be shown to the payer before they authorise, and the payer must
 * confirm it — it is the single most effective control against social-engineering fraud,
 * because the attacker controls the address string but not what the bank calls the account
 * behind it.
 */
@Controller(BENEFICIARY_ROUTES.BASE)
@UseGuards(AuthGuard)
export class BeneficiaryController {
  private readonly logger: AppLogger

  constructor(
    private readonly beneficiaries: BeneficiaryService,
    private readonly limits: LimitService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: BeneficiaryController.name })
  }

  /**
   * Look up who a UPI ID actually belongs to, without saving or paying anything.
   *
   * 200, not 201 — nothing is created. Its own route because it must happen BEFORE the
   * decision it informs: folded into the transfer call, the name would arrive after the user
   * had already committed.
   */
  @Post(BENEFICIARY_ROUTES.RESOLVE)
  @HttpCode(HttpStatus.OK)
  async resolve(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ResolveVpaSchema)) dto: ResolveVpaDto,
  ) {
    const resolved = await this.beneficiaries.resolve(user.id, dto.vpa)
    return ResponseBuilder.success(
      {
        vpa: resolved.handle,
        reachable: resolved.reachable,
        // The whole point of the endpoint. Shown verbatim, in the casing the bank returned.
        registeredName: resolved.registeredName,
        bankName: resolved.bankName ?? null,
        reason: resolved.reason ?? null,
      },
      resolved.reachable
        ? `This UPI ID belongs to ${resolved.registeredName}`
        : (resolved.reason ?? 'That UPI ID could not be verified'),
    )
  }

  /**
   * Look up who is at a mobile number.
   *
   * 200 and never 404, even when nothing is found. "No UPI ID is registered at this number" is a
   * legitimate answer to a well-formed question, not a missing resource — and a 404 would make every
   * client's error handler present it as a failure when the correct next step is simply "ask them for
   * their UPI ID instead".
   *
   * The response echoes the number MASKED. The client already knows what the user typed, so sending
   * the full number back adds nothing and puts a third party's payable address into another log.
   */
  @Post(BENEFICIARY_ROUTES.RESOLVE_MOBILE)
  @HttpCode(HttpStatus.OK)
  async resolveMobile(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ResolveMobileSchema)) dto: ResolveMobileDto,
  ) {
    const found = await this.beneficiaries.resolveMobile(user.id, dto)

    return ResponseBuilder.success(
      {
        phone: found.phone,
        country: found.country,
        matches: found.matches.map((match) => ({
          handle: match.handle,
          handleType: match.handleType,
          registeredName: match.registeredName,
          bankName: match.bankName ?? null,
        })),
        railUnavailable: found.railUnavailable,
      },
      found.matches.length > 0
        ? `This number belongs to ${found.matches[0]?.registeredName}`
        : found.railUnavailable
          ? 'We could not reach the payment network. Please try again in a moment.'
          : 'No UPI ID is registered against that number. Ask them for their UPI ID instead.',
    )
  }

  @Get(BENEFICIARY_ROUTES.LIST)
  async list(
    @User() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(BeneficiaryListQuerySchema))
    query: BeneficiaryListQueryDto,
  ) {
    const { items, total } = await this.beneficiaries.list(user.id, query)
    return ResponseBuilder.paginatedWithOffset(
      items.map((item) => this.present(item)),
      total,
      query.offset,
      query.limit,
      'Your payees',
    )
  }

  /**
   * Add a payee.
   *
   * Resolves the bank-registered name and — for a cross-border payee — screens them against
   * the compliance watchlists, before the row is usable. A beneficiary whose screening did not
   * complete cannot be paid internationally; fail-closed, because the alternative is paying a
   * sanctioned party because a vendor was down.
   */
  @Post(BENEFICIARY_ROUTES.ADD)
  async add(
    @User() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(AddBeneficiarySchema)) dto: AddBeneficiaryDto,
  ) {
    const beneficiary = await this.beneficiaries.add(user.id, dto)
    this.logger.info(`[${this.add.name}] Payee added`, {
      userId: user.id,
      beneficiaryId: beneficiary.id,
      status: beneficiary.status,
    })

    return ResponseBuilder.success(
      this.present(beneficiary),
      beneficiary.status === BeneficiaryStatus.VERIFIED
        ? `Payee added — ${beneficiary.registeredName}`
        : (beneficiary.statusReason ?? 'Payee added but not yet verified'),
    )
  }

  @Get(BENEFICIARY_ROUTES.DETAIL)
  async detail(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const beneficiary = await this.beneficiaries.get(user.id, id)
    return ResponseBuilder.success(this.present(beneficiary), 'Payee')
  }

  /** Re-run the name check. Also restarts the new-payee cooling period. */
  @Post(BENEFICIARY_ROUTES.REVERIFY)
  async reverify(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const beneficiary = await this.beneficiaries.reverify(user.id, id)
    return ResponseBuilder.success(
      this.present(beneficiary),
      beneficiary.status === BeneficiaryStatus.VERIFIED
        ? `Verified — ${beneficiary.registeredName}`
        : (beneficiary.statusReason ?? 'Could not verify that payee'),
    )
  }

  /**
   * Block a payee.
   *
   * Distinct from removing one, and the distinction matters: a removed payee can be re-added
   * in seconds with a fresh cooling period, whereas a blocked one keeps refusing. When a user
   * says "this person scammed me", block is the honest answer.
   */
  @Post(BENEFICIARY_ROUTES.BLOCK)
  async block(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(BlockBeneficiarySchema))
    dto: BlockBeneficiaryDto,
  ) {
    const beneficiary = await this.beneficiaries.block(user.id, id, dto.reason)
    return ResponseBuilder.success(
      this.present(beneficiary),
      'Payee blocked. No further payments will be sent to them.',
    )
  }

  @Post(BENEFICIARY_ROUTES.UNBLOCK)
  async unblock(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    const beneficiary = await this.beneficiaries.unblock(user.id, id)
    return ResponseBuilder.success(this.present(beneficiary), 'Payee unblocked')
  }

  /** Remove a payee. Soft — past transactions still need to name them. */
  @Delete(BENEFICIARY_ROUTES.REMOVE)
  async remove(
    @User() user: AuthenticatedUser,
    @Param('id', new UUIDValidationPipe()) id: string,
  ) {
    await this.beneficiaries.remove(user.id, id)
    return ResponseBuilder.success({ id }, 'Payee removed')
  }

  /**
   * The wire shape.
   *
   * Carries `coolingPeriod`, so the app can explain the ₹5,000 cap on a newly added payee up
   * front instead of letting the user type a larger amount and be refused at the confirmation
   * screen.
   */
  private present(beneficiary: Beneficiary) {
    const established = beneficiary.verifiedAt ?? beneficiary.createdAt
    const coolingUntil = new Date(established.getTime() + 24 * 60 * 60 * 1_000)
    const inCoolingPeriod = !beneficiary.isSelf && coolingUntil > new Date()

    return {
      id: beneficiary.id,
      displayName: beneficiary.displayName,
      registeredName: beneficiary.registeredName,
      handleType: beneficiary.handleType,
      // Masked. A payee list is a screenshot away from being shared, and a full VPA or account
      // number is directly payable by whoever reads it.
      handle: maskHandle(beneficiary.handle),
      country: beneficiary.country,
      currency: beneficiary.currency,
      status: beneficiary.status,
      statusReason: beneficiary.statusReason,
      isSelf: beneficiary.isSelf,
      screened: Boolean(beneficiary.screenedAt),
      verifiedAt: beneficiary.verifiedAt,
      lastUsedAt: beneficiary.lastUsedAt,
      coolingPeriod: inCoolingPeriod
        ? {
            until: coolingUntil,
            capMinor: this.limits
              .policy(
                beneficiary.handleType === 'PAYNOW_UPI'
                  ? 'CROSS_BORDER'
                  : 'DOMESTIC',
              )
              .newBeneficiary24hMinor.toString(),
            reason:
              'For your safety, payments to a newly added payee are capped for the first 24 hours',
          }
        : null,
    }
  }
}
