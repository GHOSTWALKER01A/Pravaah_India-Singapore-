import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AdminClaimQueueQuerySchema,
  AdminPolicyListQuerySchema,
  ClaimDecisionBodySchema,
  LossRatioQuerySchema,
  SetProductActiveSchema,
  UpsertInsuranceProductSchema,
  type AdminClaimQueueQueryDto,
  type AdminPolicyListQueryDto,
  type ClaimDecisionBodyDto,
  type LossRatioQueryDto,
  type SetProductActiveDto,
  type UpsertInsuranceProductDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { ResponseBuilder } from '@/utils/response-builder'

import { ADMIN_INSURANCE_ROUTES } from '@/modules/insurance/insurance.route'
import { ClaimsService } from '@/modules/insurance/services/claims.service'
import { InsuranceAdminService } from '@/modules/insurance/services/insurance-admin.service'
import { InsuranceLifecycleService } from '@/modules/insurance/services/insurance-lifecycle.service'
import { moneyView } from '@/modules/payments/money.util'

import { AdminRole, type AdminUser } from 'generated/prisma/client'

/**
 * The insurance console.
 *
 * Two things about the guarding are deliberate and worth stating:
 *
 *  - **The acting admin always comes from `req.admin`**, populated by
 *    {@link AdminAuthGuard} from the verified session. Never from the body. A claim
 *    approval is money leaving on a human's judgement, and an `adminId` a caller could
 *    supply would make every approval unattributable — which is indistinguishable from a
 *    fraudulent one after the fact.
 *  - **Product editing is ADMIN-only; claim adjudication is open to REVIEWERs.** A
 *    reviewer decides individual claims, which is bounded by the policy's own cover. An
 *    admin changes the PRICE OF THE PRODUCT, which is unbounded and affects everybody who
 *    buys next. Those are different powers and they get different roles.
 */
@Controller(ADMIN_INSURANCE_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminInsuranceController {
  private readonly logger: AppLogger

  constructor(
    private readonly admin: InsuranceAdminService,
    private readonly claims: ClaimsService,
    private readonly lifecycle: InsuranceLifecycleService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AdminInsuranceController.name })
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  @Get(ADMIN_INSURANCE_ROUTES.STATS)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async stats() {
    return ResponseBuilder.success(
      await this.admin.stats(),
      'Insurance portfolio',
    )
  }

  /**
   * The loss ratio and the underwriting position.
   *
   * The one figure an insurance judge or an actuary looks for, and it is derived from the
   * LEDGER rather than from application tables — so it reconciles against M4's trial
   * balance. Two numbers that agree with each other are worth more than either alone.
   *
   * Open to SENIOR_REVIEWER as well as ADMIN: somebody adjudicating large claims needs to
   * know whether the book is in surplus, and withholding that makes their decisions worse
   * rather than safer.
   */
  @Get(ADMIN_INSURANCE_ROUTES.BOOK)
  @AdminRoles(AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async book(
    @Query(new ZodValidationPipe(LossRatioQuerySchema))
    query: LossRatioQueryDto,
  ) {
    return ResponseBuilder.success(
      await this.admin.book(query),
      'Insurance book — earned premium, claims paid, loss ratio',
    )
  }

  // ── the catalogue ─────────────────────────────────────────────────────────
  @Get(ADMIN_INSURANCE_ROUTES.PRODUCTS)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async products() {
    const items = await this.admin.listProducts()
    return ResponseBuilder.success(
      items.map((product) => ({
        ...product,
        minCoverMinor: product.minCoverMinor.toString(),
        maxCoverMinor: product.maxCoverMinor.toString(),
        minCover: moneyView(product.minCoverMinor, product.currency),
        maxCover: moneyView(product.maxCoverMinor, product.currency),
      })),
      'Product catalogue',
    )
  }

  @Post(ADMIN_INSURANCE_ROUTES.PRODUCTS)
  @AdminRoles(AdminRole.ADMIN)
  async createProduct(
    @Req() request: { admin: AdminUser },
    @Body(new ZodValidationPipe(UpsertInsuranceProductSchema))
    dto: UpsertInsuranceProductDto,
  ) {
    const product = await this.admin.createProduct(request.admin, dto)
    this.logger.info(`[${this.createProduct.name}] Product created`, {
      productId: product.id,
      adminId: request.admin.id,
    })
    return ResponseBuilder.success(
      {
        ...product,
        minCoverMinor: product.minCoverMinor.toString(),
        maxCoverMinor: product.maxCoverMinor.toString(),
      },
      'Product created',
    )
  }

  /**
   * Reprice or amend a product.
   *
   * `PUT`, and the response says explicitly that live policies are untouched. A repricing
   * changes what the NEXT applicant pays; every existing policy's premium lives on the
   * policy and the quote that priced it. An admin who believed otherwise would think they
   * had just changed thousands of people's monthly debits.
   */
  @Put(ADMIN_INSURANCE_ROUTES.PRODUCT_DETAIL)
  @AdminRoles(AdminRole.ADMIN)
  async updateProduct(
    @Req() request: { admin: AdminUser },
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(UpsertInsuranceProductSchema))
    dto: UpsertInsuranceProductDto,
  ) {
    const product = await this.admin.updateProduct(request.admin, id, dto)
    return ResponseBuilder.success(
      {
        ...product,
        minCoverMinor: product.minCoverMinor.toString(),
        maxCoverMinor: product.maxCoverMinor.toString(),
      },
      'Product updated. Existing policies keep the premium they were sold at — this affects new quotes only.',
    )
  }

  @Post(ADMIN_INSURANCE_ROUTES.PRODUCT_ACTIVE)
  @AdminRoles(AdminRole.ADMIN)
  async setProductActive(
    @Req() request: { admin: AdminUser },
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(SetProductActiveSchema))
    dto: SetProductActiveDto,
  ) {
    const product = await this.admin.setProductActive(
      request.admin,
      id,
      dto.isActive,
    )
    return ResponseBuilder.success(
      { id: product.id, isActive: product.isActive },
      dto.isActive
        ? 'Product is available for new quotes'
        : 'Product withdrawn from new quotes. Existing policies are unaffected and stay in force.',
    )
  }

  // ── the claim queue ───────────────────────────────────────────────────────
  @Get(ADMIN_INSURANCE_ROUTES.CLAIMS)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async claimQueue(
    @Query(new ZodValidationPipe(AdminClaimQueueQuerySchema))
    query: AdminClaimQueueQueryDto,
  ) {
    const { items, total } = await this.admin.claimQueue(query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      'Claim queue — oldest first',
    )
  }

  @Get(ADMIN_INSURANCE_ROUTES.CLAIM_DETAIL)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async claimDetail(@Param('id', new UUIDValidationPipe()) id: string) {
    return ResponseBuilder.success(
      await this.admin.claimDetail(id),
      'Claim detail',
    )
  }

  /**
   * Decide a claim.
   *
   * The acting admin comes from the session. `reason` is mandatory on every branch —
   * including an approval — because an approval nobody has to justify is the shape of
   * internal fraud, and a rejection with no stated ground is one the claimant cannot
   * appeal.
   *
   * On approval this triggers a real payout over the M4 ledger. If the payout does not
   * settle, the claim stays APPROVED and the lifecycle sweep retries — the response says
   * so, rather than reporting a success the claimant will not see in their wallet.
   */
  @Post(ADMIN_INSURANCE_ROUTES.CLAIM_DECIDE)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async decide(
    @Req() request: { admin: AdminUser },
    @Param('id', new UUIDValidationPipe()) id: string,
    @Body(new ZodValidationPipe(ClaimDecisionBodySchema))
    dto: ClaimDecisionBodyDto,
  ) {
    this.logger.info(`[${this.decide.name}] Claim decision`, {
      claimId: id,
      decision: dto.decision,
      adminId: request.admin.id,
    })

    const result = await this.claims.decide(
      { type: 'ADMIN', admin: request.admin },
      id,
      dto.decision,
      dto.reason,
      dto.approveMinor ? BigInt(dto.approveMinor) : undefined,
    )

    return ResponseBuilder.success(
      {
        id: result.claim.id,
        claimNumber: result.claim.claimNumber,
        status: result.claim.status,
        amountApprovedMinor:
          result.claim.amountApprovedMinor?.toString() ?? null,
        payoutTransactionId: result.payoutTxnId,
        payoutPending: result.payoutPending,
      },
      result.payoutPending
        ? 'Claim approved. The payout has not settled yet — it will be retried automatically and the claim stays approved until it does.'
        : `Claim ${result.claim.status.toLowerCase()}`,
    )
  }

  /**
   * Decrypt one claim document's extraction.
   *
   * SENIOR_REVIEWER and above, and it writes its own audit row. A hospital bill names a
   * diagnosis and a treating physician; making the reveal an explicit, logged act is what
   * turns "encrypted at rest" into an access control rather than a storage detail.
   */
  @Get(ADMIN_INSURANCE_ROUTES.CLAIM_DOCUMENT_REVEAL)
  @AdminRoles(AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async revealDocument(
    @Req() request: { admin: AdminUser },
    @Param('docId', new UUIDValidationPipe()) docId: string,
  ) {
    return ResponseBuilder.success(
      await this.admin.revealDocumentExtraction(request.admin, docId),
      'Document extraction — this access has been recorded',
    )
  }

  // ── policies ──────────────────────────────────────────────────────────────
  @Get(ADMIN_INSURANCE_ROUTES.POLICIES)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async policies(
    @Query(new ZodValidationPipe(AdminPolicyListQuerySchema))
    query: AdminPolicyListQueryDto,
  ) {
    const { items, total } = await this.admin.policies(query)
    return ResponseBuilder.paginatedWithOffset(
      items,
      total,
      query.offset,
      query.limit,
      'Policies',
    )
  }

  @Get(ADMIN_INSURANCE_ROUTES.POLICY_PREMIUMS)
  @AdminRoles(AdminRole.REVIEWER, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async premiums(@Param('id', new UUIDValidationPipe()) id: string) {
    return ResponseBuilder.success(
      await this.admin.premiumHistory(id),
      'Premium history',
    )
  }

  // ── the sweeps ────────────────────────────────────────────────────────────
  /**
   * Run every lifecycle sweep now.
   *
   * ADMIN-only, because it can lapse policies and pay out approved claims. Exists so the
   * dunning path and the payout retry are demonstrable on demand rather than only on the
   * hour — the states they produce (grace, lapse, a recovered payout) are the ones worth
   * showing and the hardest to wait for.
   */
  @Post(ADMIN_INSURANCE_ROUTES.RUN_LIFECYCLE)
  @AdminRoles(AdminRole.ADMIN)
  async runLifecycle(@Req() request: { admin: AdminUser }) {
    this.logger.warn(
      `[${this.runLifecycle.name}] Lifecycle sweeps forced by an admin`,
      { adminId: request.admin.id },
    )
    return ResponseBuilder.success(
      await this.lifecycle.runAllNow(),
      'Lifecycle sweeps complete',
    )
  }
}
