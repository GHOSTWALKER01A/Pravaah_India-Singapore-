import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  AddFraudCaseNoteSchema,
  AddListEntrySchema,
  FraudCaseQuerySchema,
  RemoveListEntrySchema,
  ResolveFraudCaseSchema,
  type AddFraudCaseNoteDto,
  type AddListEntryDto,
  type FraudCaseQueryDto,
  type RemoveListEntryDto,
  type ResolveFraudCaseDto,
} from '@pravaah/schema'

import { AdminRoles } from '@/common/decorators/admin-roles.decorator'
import { AdminAuthGuard } from '@/common/guards/admin-auth.guard'
import { AdminRolesGuard } from '@/common/guards/admin-roles.guard'
import { UUIDValidationPipe } from '@/common/pipes/uuid-validation.pipe'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipes'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { ResponseBuilder } from '@/utils/response-builder'

import { ADMIN_FRAUD_ROUTES } from '@/modules/fraud/fraud.route'
import { FraudProviderRegistry } from '@/modules/fraud/providers/fraud-provider.registry'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'
import { FraudCaseService } from '@/modules/fraud/services/fraud-case.service'
import { MuleGraphService } from '@/modules/fraud/services/mule-graph.service'
import { RiskService } from '@/modules/fraud/services/risk.service'
import { WatchlistService } from '@/modules/fraud/services/watchlist.service'

import {
  ActorType,
  AdminRole,
  RiskDecision,
  RiskSubjectType,
  type AdminUser,
} from 'generated/prisma/client'

/**
 * The fraud analyst console.
 *
 * ## Two guarding decisions, both deliberate
 *
 *  - **The acting analyst always comes from `req.admin`**, populated by
 *    {@link AdminAuthGuard} from the verified session — never from the body. The M6
 *    build doc's version took `analystId` and `role` as body fields, which would let any
 *    authenticated analyst confirm a sanctions case by typing `"role": "ADMIN"` and make
 *    every case release unattributable. Clearing a case RELEASES money an automated
 *    control had stopped; an unattributable release is the single most useful thing an
 *    insider could do.
 *  - **Reading is open to any analyst; the heavy controls are not.** Permanent blocklist
 *    entries and account suspension are `SENIOR_REVIEWER`/`ADMIN`, because both outlive
 *    the case and affect people who are not party to it — a mule listing on a VPA blocks
 *    every future user who tries to pay it.
 *
 * Mounted under `admin/` so no user-facing guard can be inherited onto it. A fraud queue
 * reachable with a user's own token would let a suspect read their own case, including
 * which signals fired — the evasion instructions.
 */
@Controller(ADMIN_FRAUD_ROUTES.BASE)
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles(AdminRole.ANALYST, AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
export class AnalystController {
  private readonly logger: AppLogger

  constructor(
    private readonly cases: FraudCaseService,
    private readonly risk: RiskService,
    private readonly watchlist: WatchlistService,
    private readonly graph: MuleGraphService,
    private readonly devices: DeviceTrustService,
    private readonly providers: FraudProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: AnalystController.name })
  }

  // ── overview ──────────────────────────────────────────────────────────────
  /**
   * Operational stats.
   *
   * `cases.slaBreached` is the number to page on: it counts people whose money has been
   * held past the promised window. `providers` is included so an auditor can read
   * whether SIM-swap detection is carrier-corroborated without inferring it from
   * behaviour — the same honesty M5's console applies to its mock insurer.
   */
  @Get(ADMIN_FRAUD_ROUTES.STATS)
  async stats() {
    const [stats, providers] = await Promise.all([
      this.cases.stats(),
      Promise.resolve(this.providers.describe()),
    ])
    return ResponseBuilder.success(
      { ...stats, providers },
      'Fraud operations overview',
    )
  }

  // ── cases ─────────────────────────────────────────────────────────────────
  @Get(ADMIN_FRAUD_ROUTES.CASES)
  async queue(
    @Query(new ZodValidationPipe(FraudCaseQuerySchema))
    query: FraudCaseQueryDto,
    @Req() req: { admin: AdminUser },
  ) {
    const result = await this.cases.queue({
      status: query.status,
      severity: query.severity,
      analystId: query.mine ? req.admin.id : undefined,
      limit: query.limit,
      offset: query.offset,
    })

    return ResponseBuilder.success(result, 'The fraud queue')
  }

  @Get(ADMIN_FRAUD_ROUTES.CASE_DETAIL)
  async caseDetail(@Param('id', UUIDValidationPipe) caseId: string) {
    const detail = await this.cases.detail(caseId)
    return ResponseBuilder.success(detail, 'Case detail')
  }

  /**
   * Take ownership.
   *
   * Atomic, so two analysts clicking the same row get one winner and one 409 rather than
   * a silent overwrite. In a shared console that race is routine, not hypothetical.
   */
  @Post(ADMIN_FRAUD_ROUTES.CASE_CLAIM)
  async claimCase(
    @Param('id', UUIDValidationPipe) caseId: string,
    @Req() req: { admin: AdminUser },
  ) {
    await this.cases.claim(caseId, {
      id: req.admin.id,
      role: req.admin.role,
    })
    return ResponseBuilder.success({ caseId }, 'You are working this case')
  }

  @Post(ADMIN_FRAUD_ROUTES.CASE_NOTE)
  async addNote(
    @Param('id', UUIDValidationPipe) caseId: string,
    @Body(new ZodValidationPipe(AddFraudCaseNoteSchema))
    dto: AddFraudCaseNoteDto,
    @Req() req: { admin: AdminUser },
  ) {
    await this.cases.addNote(
      caseId,
      { id: req.admin.id, role: req.admin.role },
      dto.note,
    )
    return ResponseBuilder.success({ caseId }, 'Note added')
  }

  @Post(ADMIN_FRAUD_ROUTES.CASE_REQUEST_INFO)
  async requestInfo(
    @Param('id', UUIDValidationPipe) caseId: string,
    @Body(new ZodValidationPipe(AddFraudCaseNoteSchema))
    dto: AddFraudCaseNoteDto,
    @Req() req: { admin: AdminUser },
  ) {
    await this.cases.requestInfo(
      caseId,
      { id: req.admin.id, role: req.admin.role },
      dto.note,
    )
    return ResponseBuilder.success(
      { caseId },
      'Information requested — the SLA clock is paused',
    )
  }

  /**
   * Decide a case.
   *
   * `CLEARED` releases the held action downstream and `CONFIRMED_FRAUD` blocks it, lists
   * the artefacts and suspends the account — all through `RiskActionRegistry`, so this
   * controller never imports M4 or M5.
   *
   * The response reports `actionApplied` separately from `status`, because they can
   * genuinely disagree: a case may be CLEARED while the release fails because the
   * transaction expired during the review. Reporting one number for both would tell an
   * analyst a payment was released when it was not.
   */
  @Post(ADMIN_FRAUD_ROUTES.CASE_RESOLVE)
  async resolveCase(
    @Param('id', UUIDValidationPipe) caseId: string,
    @Body(new ZodValidationPipe(ResolveFraudCaseSchema))
    dto: ResolveFraudCaseDto,
    @Req() req: { admin: AdminUser },
  ) {
    const result = await this.cases.resolve({
      caseId,
      analyst: { id: req.admin.id, role: req.admin.role },
      outcome: dto.outcome,
      note: dto.note,
    })

    return ResponseBuilder.success(
      { caseId, ...result },
      result.actionApplied
        ? 'Case resolved and the action applied'
        : `Case resolved. Downstream action not applied: ${result.actionResult}`,
    )
  }

  // ── assessments ───────────────────────────────────────────────────────────
  /**
   * Every assessment, filterable. The model's behaviour, inspectable.
   *
   * Unlike the user-facing view this DOES include scores and weights — an analyst
   * defending a hold, or tuning a threshold, needs the arithmetic. That asymmetry is the
   * point of having two projections rather than one.
   */
  @Get(ADMIN_FRAUD_ROUTES.ASSESSMENTS)
  async assessments(
    @Query('decision') decision?: string,
    @Query('subjectType') subjectType?: string,
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const [items, total] = await this.risk.listAssessments({
      decision: decision as RiskDecision | undefined,
      subjectType: subjectType as RiskSubjectType | undefined,
      userId,
      limit: clampInt(limit, 25, 1, 100),
      offset: clampInt(offset, 0, 0, 100_000),
    })

    return ResponseBuilder.success({ items, total }, 'Risk assessments')
  }

  @Get(ADMIN_FRAUD_ROUTES.ASSESSMENT_DETAIL)
  async assessmentDetail(@Param('id', UUIDValidationPipe) id: string) {
    const detail = await this.risk.assessmentDetail(id)
    return ResponseBuilder.success(detail, 'Assessment detail')
  }

  // ── lists ─────────────────────────────────────────────────────────────────
  /**
   * Add a listing.
   *
   * SENIOR_REVIEWER or ADMIN only. A mule or sanctions listing outlives the case and
   * affects people who are not party to it — listing a VPA blocks every future user who
   * tries to pay it — so it is not a first-line decision.
   *
   * Takes the identifier in PLAINTEXT and hashes it server-side. The build doc's
   * `valueHash` field would have let the client choose the salt, so two consoles would
   * produce two different hashes for one VPA and neither would ever match a lookup.
   */
  @Post(ADMIN_FRAUD_ROUTES.LISTS)
  @AdminRoles(AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async addListEntry(
    @Body(new ZodValidationPipe(AddListEntrySchema)) dto: AddListEntryDto,
    @Req() req: { admin: AdminUser },
  ) {
    const entry = await this.watchlist.add({
      kind: dto.kind,
      entityType: dto.entityType,
      value: dto.value,
      reason: dto.reason,
      source: 'analyst',
      addedById: req.admin.id,
      expiresAt: dto.expiresAt ?? null,
    })

    return ResponseBuilder.success(
      { id: entry.id, kind: entry.kind, entityType: entry.entityType },
      'Added to the list',
    )
  }

  @Post(ADMIN_FRAUD_ROUTES.LIST_REMOVE)
  @AdminRoles(AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async removeListEntry(
    @Body(new ZodValidationPipe(RemoveListEntrySchema)) dto: RemoveListEntryDto,
    @Req() req: { admin: AdminUser },
  ) {
    const removed = await this.watchlist.remove({
      kind: dto.kind,
      entityType: dto.entityType,
      value: dto.value,
      reason: dto.reason,
      removedById: req.admin.id,
    })

    return ResponseBuilder.success(
      { removed },
      removed ? 'Listing lifted' : 'No active listing matched',
    )
  }

  /**
   * The list, as counts by kind and entity type.
   *
   * Counts and metadata only — never `valueHash`. Shipping the hashes to a browser would
   * put the one value that could be brute-forced offline into a client, which defeats
   * the reason they are hashed. An analyst checks a SPECIFIC identifier through
   * `isHardListed`; nobody needs to browse the raw list.
   */
  @Get(ADMIN_FRAUD_ROUTES.LISTS)
  async listSummary() {
    const grouped = await this.prisma.listEntry.groupBy({
      by: ['kind', 'entityType'],
      where: { active: true },
      _count: { _all: true },
    })

    return ResponseBuilder.success(
      grouped.map((row) => ({
        kind: row.kind,
        entityType: row.entityType,
        count: row._count._all,
      })),
      'Active listings',
    )
  }

  // ── one user's risk picture ───────────────────────────────────────────────
  /**
   * Everything M6 knows about one user, in one call.
   *
   * Built as one endpoint rather than five because an analyst working a case needs all
   * of it at once, and five round trips is five chances to look at a stale half of the
   * picture while deciding whether to release somebody's money.
   */
  @Get(ADMIN_FRAUD_ROUTES.USER_PROFILE)
  async userProfile(@Param('userId', UUIDValidationPipe) userId: string) {
    const [user, devices, assessments, cases, graph, recentEvents] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            pravaahId: true,
            phone: true,
            email: true,
            kycStatus: true,
            isSuspended: true,
            primaryCountry: true,
            createdAt: true,
          },
        }),
        this.devices.listForUser(userId),
        this.risk.assessmentsForUser(userId, 10),
        this.prisma.fraudCase.findMany({
          where: { userId },
          orderBy: { openedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            severity: true,
            reason: true,
            openedAt: true,
            resolvedAt: true,
          },
        }),
        this.graph.neighbourhood(userId),
        this.prisma.deviceEvent.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            type: true,
            geoHint: true,
            integrity: true,
            createdAt: true,
          },
        }),
      ])

    return ResponseBuilder.success(
      { user, devices, assessments, cases, graph, recentEvents },
      "This user's risk picture",
    )
  }

  /**
   * Suspend or restore an account.
   *
   * The heaviest control here, so it is SENIOR_REVIEWER/ADMIN and always audited.
   * `isSuspended` is honoured by M4's transfer path AND by the risk engine's hard gate,
   * so one flag stops payments, claims, consents and device binds rather than only
   * transfers.
   */
  @Post(ADMIN_FRAUD_ROUTES.USER_SUSPEND)
  @AdminRoles(AdminRole.SENIOR_REVIEWER, AdminRole.ADMIN)
  async suspendUser(
    @Param('userId', UUIDValidationPipe) userId: string,
    @Body(new ZodValidationPipe(AddFraudCaseNoteSchema))
    dto: AddFraudCaseNoteDto,
    @Query('restore') restore: string | undefined,
    @Req() req: { admin: AdminUser },
  ) {
    const suspend = restore !== 'true'

    await this.prisma.user.update({
      where: { id: userId },
      data: { isSuspended: suspend },
    })

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: req.admin.id,
      action: suspend ? 'fraud.user.suspended' : 'fraud.user.restored',
      entity: 'User',
      entityId: userId,
      metadata: { note: dto.note },
    })

    this.logger.warn(
      `[${this.suspendUser.name}] Account ${suspend ? 'suspended' : 'restored'}`,
      { userId, analystId: req.admin.id },
    )

    return ResponseBuilder.success(
      { userId, isSuspended: suspend },
      suspend ? 'Account suspended' : 'Account restored',
    )
  }

  // ── graph ─────────────────────────────────────────────────────────────────
  @Get(ADMIN_FRAUD_ROUTES.GRAPH_NEIGHBOURHOOD)
  async graphNeighbourhood(
    @Param('userId', UUIDValidationPipe) userId: string,
  ) {
    const neighbourhood = await this.graph.neighbourhood(userId)
    return ResponseBuilder.success(
      neighbourhood,
      'The link cluster around this account',
    )
  }

  /**
   * Force the cluster recompute now.
   *
   * ADMIN only, because it is an unbounded-ish traversal that an unlucky operator could
   * fire repeatedly. It exists for demos and for the first run after seeding, where
   * waiting fifteen minutes for the scheduled pass would be the difference between a
   * working demonstration and a blank graph.
   */
  @Post(ADMIN_FRAUD_ROUTES.GRAPH_RECOMPUTE)
  @AdminRoles(AdminRole.ADMIN)
  async recomputeGraph(@Req() req: { admin: AdminUser }) {
    const result = await this.graph.recomputeClusters()

    await this.audit.log({
      actorType: ActorType.ADMIN,
      actorId: req.admin.id,
      action: 'fraud.graph.recomputed',
      entity: 'GraphNodeScore',
      metadata: result,
    })

    return ResponseBuilder.success(result, 'Graph recomputed')
  }
}

/**
 * Parse a query integer, clamped.
 *
 * Hand-rolled rather than Zod because these are loose query params on read-only admin
 * endpoints and a 400 on `?limit=abc` would be worse UX than falling back to the
 * default. The clamp is the part that matters — an unbounded `limit` is a
 * denial-of-service against our own database.
 */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}
