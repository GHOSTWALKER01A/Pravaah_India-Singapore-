import { createHash } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CLAIM_CATALOGUE,
  normalizePravaahId,
  type CreatePartnerVerificationDto,
  type CreateVerifierRequestDto,
  type DisclosableClaim,
  type PartnerDecisionDto,
  type PartnerDirectVerifyDto,
  type PartnerVerificationListQueryDto,
  type PredicateSpec,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { decodeJwsUnverified } from '@/modules/passport/crypto/jose.util'
import { parseCombined } from '@/modules/passport/crypto/sd-jwt.util'
import {
  claimsOutsideScope,
  resolveTemplate,
} from '@/modules/passport/passport.state'
import { VerificationService } from '@/modules/passport/services/verification.service'
import { VerifierSessionService } from '@/modules/passport/services/verifier-session.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import {
  ActorType,
  PartnerStatus,
  PartnerUsageKind,
  Prisma,
  VerifierRequestStatus,
  type VerifierPartner,
} from 'generated/prisma/client'

import {
  PredicateError,
  compilePredicates,
  evaluatePredicates,
  isRedacted,
  predicateClaims,
  projectResultForPartner,
  readCompiledPredicates,
  type CompiledPredicate,
} from '@/modules/partner/partner.state'
import { PartnerTemplateService } from '@/modules/partner/services/partner-template.service'
import { PartnerUsageService } from '@/modules/partner/services/partner-usage.service'
import { TrustRegistryService } from '@/modules/partner/services/trust-registry.service'
import { VerificationAbuseService } from '@/modules/partner/services/verification-abuse.service'

/**
 * Who is acting. Exactly one of `apiKeyId` / `partnerUserId` is set: a request is
 * attributable to the integration or the person that made it.
 */
export interface PartnerActor {
  partner: VerifierPartner
  /** The claims this actor may request — key scope ∩ partner scope, or the partner's. */
  scopes: readonly string[]
  apiKeyId?: string | null
  partnerUserId?: string | null
}

/** Statuses in which a verification SUCCEEDED and a decision may be recorded. */
const DECIDABLE: readonly VerifierRequestStatus[] = [
  VerifierRequestStatus.APPROVED,
  VerifierRequestStatus.CONSUMED,
]

/**
 * The partner's side of a verification — M7's orchestrator.
 *
 * It does NOT re-implement the handshake. Opening, answering and collecting a
 * request are M3's `VerifierSessionService`; verifying a presentation is M3's
 * `VerificationService`. This service adds what a commercial relying party needs
 * around them: predicates, saved templates, idempotent creates, abuse ceilings,
 * scope-filtered results, underwriting decisions, and direct verification behind
 * the trust registry with genuinely single-use nonces.
 */
@Injectable()
export class PartnerVerificationService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: VerifierSessionService,
    private readonly verification: VerificationService,
    private readonly templates: PartnerTemplateService,
    private readonly trust: TrustRegistryService,
    private readonly usage: PartnerUsageService,
    private readonly abuse: VerificationAbuseService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PartnerVerificationService.name })
  }

  // ── create ────────────────────────────────────────────────────────────────
  /**
   * Open a verification.
   *
   * With an `Idempotency-Key`, a replay returns the ORIGINAL request (flagged
   * `replayed: true`) instead of opening a second prompt on the holder's phone —
   * a retried HTTP call must not become two consent requests. A concurrent replay
   * that races past the lookup collides on `(partnerId, idempotencyKey)` and is
   * answered the same way.
   */
  async create(
    actor: PartnerActor,
    dto: CreatePartnerVerificationDto,
    idempotencyKey?: string | null,
  ): Promise<Record<string, unknown>> {
    this.assertActive(actor.partner)

    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        actor.partner.id,
        idempotencyKey,
      )
      if (existing) return existing
    }

    // ── what is being asked ──
    const partnerTemplate = dto.templateId
      ? await this.templates.requireUsable(actor.partner.id, dto.templateId)
      : null

    const specs: PredicateSpec[] = [
      ...((partnerTemplate?.predicates as PredicateSpec[] | undefined) ?? []),
      ...(dto.predicates ?? []),
    ]
    const compiled = this.compile(specs)
    const thresholdClaims = predicateClaims(compiled)

    let m3dto: CreateVerifierRequestDto
    let extraClaims: string[]
    if (dto.template) {
      // A catalogue template, widened by any explicit claims and predicate claims.
      m3dto = this.baseDto(dto, { template: dto.template })
      extraClaims = [...(dto.requestedClaims ?? []), ...thresholdClaims]
    } else if (partnerTemplate) {
      m3dto = this.baseDto(dto, {
        requestedClaims: [
          ...(partnerTemplate.claims as DisclosableClaim[]),
          ...(dto.requestedClaims ?? []),
        ],
        purpose: dto.purpose ?? partnerTemplate.purpose,
      })
      extraClaims = thresholdClaims
    } else {
      m3dto = this.baseDto(dto, {
        requestedClaims: dto.requestedClaims ?? [],
        purpose: dto.purpose,
      })
      extraClaims = thresholdClaims
    }

    // Scope is checked HERE as well as in M3, so the error names the offending
    // predicate claims in the partner's own terms before anything is written.
    const asked = [
      ...(dto.template
        ? resolveTemplate(dto.template).claims
        : (m3dto.requestedClaims ?? [])),
      ...extraClaims,
    ]
    const outside = claimsOutsideScope(asked, actor.scopes)
    if (outside.length) {
      throw new ForbiddenException(
        `This request asks for claims outside ${actor.apiKeyId ? 'this key’s' : 'your'} approved scope: ${outside.join(', ')}`,
      )
    }

    // ── who is being asked, and whether they should be ──
    const targetUserId = await this.resolveTargetUser(dto)
    if (targetUserId)
      await this.abuse.assertCanOpen(actor.partner.id, targetUserId)

    try {
      const opened = await this.sessions.createRequest(m3dto, actor.partner, {
        scopes: actor.scopes,
        extraClaims,
        apiKeyId: actor.apiKeyId ?? null,
        partnerTemplateId: partnerTemplate?.id ?? null,
        externalRef: dto.externalRef ?? null,
        idempotencyKey: idempotencyKey ?? null,
        predicates: compiled.length
          ? (compiled as unknown as Prisma.InputJsonValue)
          : null,
        createdByPartnerUserId: actor.partnerUserId ?? null,
      })
      return {
        ...opened,
        predicates: compiled.map((p) => ({
          key: p.key,
          answeredBy: p.clauses.map((c) => c.claim),
        })),
        replayed: false,
      }
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findByIdempotencyKey(
          actor.partner.id,
          idempotencyKey,
        )
        if (existing) return existing
      }
      throw error
    }
  }

  // ── read ──────────────────────────────────────────────────────────────────
  async list(partnerId: string, query: PartnerVerificationListQueryDto) {
    const where: Prisma.VerifierRequestWhereInput = {
      partnerId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.externalRef ? { externalRef: query.externalRef } : {}),
      ...(query.decision ? { decision: { decision: query.decision } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.verifierRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          status: true,
          externalRef: true,
          purpose: true,
          template: true,
          requestedClaims: true,
          predicates: true,
          channel: true,
          createdAt: true,
          expiresAt: true,
          respondedAt: true,
          apiKeyId: true,
          createdByPartnerUserId: true,
          decision: {
            select: { decision: true, decidedAt: true, revision: true },
          },
          consentReceipt: { select: { status: true, withdrawnAt: true } },
        },
      }),
      this.prisma.verifierRequest.count({ where }),
    ])
    return {
      total,
      items: rows.map((row) => ({
        requestId: row.id,
        status: this.displayStatus(row.status, row.expiresAt),
        externalRef: row.externalRef,
        purpose: row.purpose,
        template: row.template,
        requestedClaims: row.requestedClaims,
        predicates: readCompiledPredicates(row.predicates).map((p) => p.key),
        channel: row.channel,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        respondedAt: row.respondedAt,
        openedBy: row.apiKeyId
          ? 'API_KEY'
          : row.createdByPartnerUserId
            ? 'CONSOLE'
            : 'LEGACY_KEY',
        decision: row.decision,
        consent: row.consentReceipt,
      })),
    }
  }

  /**
   * One verification, as the partner may see it.
   *
   * Reading an APPROVED result collects it through M3 (burning the nonce, exactly
   * as M3's own poll does), so the two read paths cannot disagree about whether a
   * result has been collected. The claims are then re-filtered to the partner's
   * CURRENT scope and predicates are answered from the verified booleans.
   */
  async detail(
    actor: PartnerActor,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const request = await this.requireOwned(actor.partner.id, requestId)

    if (request.status === VerifierRequestStatus.APPROVED) {
      await this.sessions.result(requestId, actor.partner)
    }
    const fresh = await this.prisma.verifierRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: {
        decision: true,
        consentReceipt: {
          select: {
            id: true,
            status: true,
            withdrawnAt: true,
            purgeAt: true,
            purgedAt: true,
          },
        },
      },
    })

    const compiled = readCompiledPredicates(fresh.predicates)
    const result = projectResultForPartner(
      fresh.resultJson,
      compiled,
      actor.scopes,
    )

    return {
      requestId: fresh.id,
      status: this.displayStatus(fresh.status, fresh.expiresAt),
      externalRef: fresh.externalRef,
      purpose: fresh.purpose,
      template: fresh.template,
      requestedClaims: fresh.requestedClaims,
      requestedClaimLabels: fresh.requestedClaims.map(
        (claim) => CLAIM_CATALOGUE[claim as DisclosableClaim]?.label ?? claim,
      ),
      predicates: compiled.map((p) => p.key),
      channel: fresh.channel,
      createdAt: fresh.createdAt,
      expiresAt: fresh.expiresAt,
      respondedAt: fresh.respondedAt,
      consumedAt: fresh.consumedAt,
      cancelledAt: fresh.cancelledAt,
      result,
      /**
       * When the holder withdrew (or retention elapsed), `result.claims` is empty
       * and this says why. The partner's deletion obligation for the copy it
       * already holds is theirs; the `consent.withdrawn` webhook is the notice.
       */
      dataStatus: !fresh.resultJson
        ? 'NONE'
        : isRedacted(fresh.resultJson)
          ? 'REDACTED'
          : 'AVAILABLE',
      consent: fresh.consentReceipt,
      decision: fresh.decision
        ? {
            decision: fresh.decision.decision,
            reasonCode: fresh.decision.reasonCode,
            reason: fresh.decision.reason,
            metadata: fresh.decision.metadata,
            revision: fresh.decision.revision,
            decidedAt: fresh.decision.decidedAt,
            updatedAt: fresh.decision.updatedAt,
          }
        : null,
    }
  }

  cancel(actor: PartnerActor, requestId: string, reason?: string) {
    return this.sessions.cancel(requestId, actor.partner.id, reason)
  }

  // ── decisions ─────────────────────────────────────────────────────────────
  /**
   * Record the partner's own underwriting outcome — the step that closes the audit
   * loop: request → consent → verification → decision.
   *
   * Only on a SUCCESSFUL verification: a decision against a declined or expired
   * request would be a decision about data the partner never received. A change is
   * allowed but never silent — `revision` increments and the audit log keeps every
   * version, so "approved, then quietly declined" is visible.
   */
  async decide(
    actor: PartnerActor,
    requestId: string,
    dto: PartnerDecisionDto,
  ): Promise<Record<string, unknown>> {
    const request = await this.requireOwned(actor.partner.id, requestId)
    if (!DECIDABLE.includes(request.status)) {
      throw new ConflictException(
        `A decision can only be recorded for a verified request (this one is ${request.status})`,
      )
    }

    const data = {
      decision: dto.decision,
      reasonCode: dto.reasonCode ?? null,
      reason: dto.reason ?? null,
      metadata: (dto.metadata ?? Prisma.DbNull) as Prisma.InputJsonValue,
      decidedByApiKeyId: actor.apiKeyId ?? null,
      decidedByPartnerUserId: actor.partnerUserId ?? null,
    }

    const write = async () => {
      const existing = await this.prisma.partnerDecision.findUnique({
        where: { verifierRequestId: requestId },
      })
      if (!existing) {
        const created = await this.prisma.partnerDecision.create({
          data: {
            ...data,
            verifierRequestId: requestId,
            partnerId: actor.partner.id,
          },
        })
        return { decision: created, previous: null }
      }
      const updated = await this.prisma.partnerDecision.update({
        where: { id: existing.id, revision: existing.revision },
        data: { ...data, revision: { increment: 1 } },
      })
      return { decision: updated, previous: existing }
    }

    let outcome: Awaited<ReturnType<typeof write>>
    try {
      outcome = await write()
    } catch (error) {
      // Two first decisions racing: the loser collides on the unique request id and
      // retries once as an update. A lost optimistic update (P2025) surfaces as 409.
      if (isUniqueViolation(error)) outcome = await write()
      else if (isRecordNotFound(error)) {
        throw new ConflictException(
          'The decision changed while you were saving — reload and retry',
        )
      } else throw error
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: outcome.previous
        ? 'partner.decision_revised'
        : 'partner.decision_recorded',
      entity: 'VerifierRequest',
      entityId: requestId,
      metadata: {
        partnerId: actor.partner.id,
        apiKeyId: actor.apiKeyId ?? null,
        partnerUserId: actor.partnerUserId ?? null,
        decision: outcome.decision.decision,
        reasonCode: outcome.decision.reasonCode,
        revision: outcome.decision.revision,
        previous: outcome.previous
          ? {
              decision: outcome.previous.decision,
              reasonCode: outcome.previous.reasonCode,
            }
          : null,
      },
    })

    return {
      requestId,
      decision: outcome.decision.decision,
      reasonCode: outcome.decision.reasonCode,
      reason: outcome.decision.reason,
      revision: outcome.decision.revision,
      decidedAt: outcome.decision.decidedAt,
      updatedAt: outcome.decision.updatedAt,
    }
  }

  // ── direct verification ───────────────────────────────────────────────────
  /**
   * Verify a presentation the partner received directly (its own wallet
   * integration, or an OpenID4VP `direct_post` to its endpoint).
   *
   * The checks run in the order that fails cheapest and most decisively first:
   *
   *   1. scope        — may this partner ask for these claims at all?   (no crypto)
   *   2. trust        — do we accept the credential's issuer?          (no crypto)
   *   3. M3 pipeline  — typ, issuer signature, validity, status list,
   *                     disclosure digests, KB-JWT (holder key, sd_hash, aud, nonce, iat)
   *   4. scope again  — did the holder disclose anything out of scope?
   *   5. nonce burn   — has this nonce already been spent?
   *   6. predicates   — minimal derived answers
   *
   * Every failure is an ordinary `valid: false` answer, not an HTTP error: "this
   * credential is revoked" is a successful answer to a verification question.
   */
  async verifyDirect(
    actor: PartnerActor,
    dto: PartnerDirectVerifyDto,
  ): Promise<Record<string, unknown>> {
    this.assertActive(actor.partner)
    const compiled = this.compile(dto.predicates ?? [])
    const wanted = [...(dto.requiredClaims ?? []), ...predicateClaims(compiled)]

    // 1. scope — before any work, and as a 403: the partner's REQUEST is wrong.
    const outsideAsk = claimsOutsideScope(wanted, actor.scopes)
    if (outsideAsk.length) {
      throw new ForbiddenException(
        `You are not approved to require these claims: ${outsideAsk.join(', ')}`,
      )
    }

    const nonceHash = createHash('sha256')
      .update(dto.expectedNonce)
      .digest('hex')
    const reject = async (
      code: string,
      reason: string,
      extra: Record<string, unknown> = {},
    ) => {
      await this.meterDirect(
        actor,
        PartnerUsageKind.DIRECT_REJECTED,
        `${nonceHash}:${code}:${Date.now()}`,
      )
      return { valid: false, code, reason, ...extra }
    }

    // 2. trust registry.
    let issuer: string
    try {
      const { jwt } = parseCombined(dto.presentation)
      const iss = decodeJwsUnverified(jwt).payload.iss
      if (typeof iss !== 'string') throw new Error('no iss')
      issuer = iss
    } catch {
      return reject('MALFORMED', 'The presentation could not be parsed')
    }
    const trust = await this.trust.check(issuer)
    if (!trust.accepted) {
      return reject(
        trust.reason === 'DISTRUSTED_ISSUER'
          ? 'DISTRUSTED_ISSUER'
          : 'UNTRUSTED_ISSUER',
        trust.reason === 'DISTRUSTED_ISSUER'
          ? 'This issuer is no longer accepted by the trust registry'
          : 'This issuer is not in the trust registry',
        { issuer },
      )
    }
    if (!trust.nativelyVerifiable) {
      return reject(
        'ISSUER_NOT_RESOLVABLE',
        'This issuer is trusted, but its keys and status list cannot be resolved by this deployment yet',
        { issuer },
      )
    }

    // 3. the full M3 pipeline, with the audience FORCED to this partner's.
    const verdict = await this.verification.verify({
      presentation: dto.presentation,
      expectedNonce: dto.expectedNonce,
      audience: actor.partner.audience,
      requiredClaims: dto.requiredClaims,
    })
    if (!verdict.valid) {
      return reject(
        verdict.code ?? 'INVALID',
        verdict.reason ?? 'The presentation did not verify',
        {
          issuer,
          holderVerified: false,
        },
      )
    }

    // 4. scope on what was DISCLOSED. The partner holds the bytes either way; failing
    // here tells it it is collecting data it was not approved to hold.
    const disclosed = Object.keys(verdict.claims ?? {}).filter(
      (c) => c !== 'score_scale',
    )
    const outsideDisclosed = claimsOutsideScope(disclosed, actor.scopes)
    if (outsideDisclosed.length) {
      return reject(
        'SCOPE_VIOLATION',
        `The presentation discloses claims you are not approved to receive: ${outsideDisclosed.join(', ')}`,
        { issuer },
      )
    }

    // 5. burn the nonce. The unique dedupe key makes a nonce single-use across every
    // instance: a second presentation carrying it — the same vp_token replayed, or a
    // different one minted against a leaked nonce — is refused.
    const fresh = await this.meterDirect(
      actor,
      PartnerUsageKind.DIRECT_VERIFIED,
      `direct:${actor.partner.id}:${nonceHash}`,
    )
    if (!fresh) {
      return reject(
        'REPLAY_SUSPECTED',
        'This nonce has already been used for a verified presentation',
        {
          issuer,
        },
      )
    }

    // 6. predicates.
    return {
      valid: true,
      issuer,
      issuerName: trust.entry.issuerName,
      issuerCountry: trust.entry.country,
      credentialNumber: verdict.credentialNumber,
      expiresAt: verdict.expiresAt,
      holderVerified: verdict.holderVerified,
      replayProtected: verdict.replayProtected,
      claims: verdict.claims,
      unsatisfied: verdict.unsatisfied,
      predicates: evaluatePredicates(compiled, verdict.claims ?? {}),
      externalRef: dto.externalRef,
      verifiedAt: new Date().toISOString(),
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private assertActive(partner: VerifierPartner): void {
    if (partner.status !== PartnerStatus.ACTIVE || !partner.isActive) {
      throw new ForbiddenException(
        partner.status === PartnerStatus.PENDING_APPROVAL
          ? 'Verifications are available once your application is approved'
          : `This partner is ${partner.status.toLowerCase()} and cannot verify`,
      )
    }
  }

  private compile(specs: readonly PredicateSpec[]): CompiledPredicate[] {
    try {
      return compilePredicates(specs)
    } catch (error) {
      if (error instanceof PredicateError)
        throw new BadRequestException(error.message)
      throw error
    }
  }

  private baseDto(
    dto: CreatePartnerVerificationDto,
    what: Pick<
      CreateVerifierRequestDto,
      'template' | 'requestedClaims' | 'purpose'
    >,
  ): CreateVerifierRequestDto {
    return {
      ...what,
      pravaahId: dto.pravaahId,
      cardRef: dto.cardRef,
      channel: dto.channel,
      ttlSeconds: dto.ttlSeconds,
    }
  }

  /**
   * Resolve the target holder for the abuse check, when one is named. M3 resolves
   * (and validates) it again when opening the request; this read only feeds the
   * harvesting ceiling, so an unknown id simply skips it and M3 returns the 404.
   */
  private async resolveTargetUser(
    dto: CreatePartnerVerificationDto,
  ): Promise<string | null> {
    if (dto.pravaahId) {
      const canonical = normalizePravaahId(dto.pravaahId)
      if (!canonical) return null
      const user = await this.prisma.user.findUnique({
        where: { pravaahId: canonical },
        select: { id: true },
      })
      return user?.id ?? null
    }
    if (dto.cardRef) {
      const card = await this.prisma.passportCard.findUnique({
        where: { qrPayloadRef: dto.cardRef },
        select: { userId: true },
      })
      return card?.userId ?? null
    }
    return null
  }

  private async findByIdempotencyKey(
    partnerId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown> | null> {
    const existing = await this.prisma.verifierRequest.findUnique({
      where: { partnerId_idempotencyKey: { partnerId, idempotencyKey } },
    })
    if (!existing) return null
    return {
      requestId: existing.id,
      nonce: existing.nonce,
      audience: existing.audience,
      purpose: existing.purpose,
      requestedClaims: existing.requestedClaims,
      expiresAt: existing.expiresAt,
      status: this.displayStatus(existing.status, existing.expiresAt),
      externalRef: existing.externalRef ?? undefined,
      openToAnyHolder: existing.userId === null,
      predicates: readCompiledPredicates(existing.predicates).map((p) => ({
        key: p.key,
        answeredBy: p.clauses.map((c) => c.claim),
      })),
      replayed: true,
    }
  }

  private async requireOwned(partnerId: string, requestId: string) {
    // Scoped to the partner in the WHERE: another partner's request id is a 404
    // that confirms nothing about whether it exists.
    const request = await this.prisma.verifierRequest.findFirst({
      where: { id: requestId, partnerId },
      select: { id: true, status: true },
    })
    if (!request) throw new NotFoundException('Verification not found')
    return request
  }

  /** A PENDING request past its expiry reads as EXPIRED before the sweep catches it. */
  private displayStatus(
    status: VerifierRequestStatus,
    expiresAt: Date,
  ): VerifierRequestStatus {
    return status === VerifierRequestStatus.PENDING && expiresAt <= new Date()
      ? VerifierRequestStatus.EXPIRED
      : status
  }

  /** Record a direct-verification event. Returns false when it was already recorded. */
  private async meterDirect(
    actor: PartnerActor,
    kind: PartnerUsageKind,
    dedupeKey: string,
  ): Promise<boolean> {
    try {
      const created = await this.usage.record(this.prisma, [
        {
          partnerId: actor.partner.id,
          kind,
          dedupeKey,
          apiKeyId: actor.apiKeyId ?? null,
        },
      ])
      return created > 0
    } catch (error) {
      // Metering a REJECTION must never turn a verdict into a 500. Metering a success
      // is the nonce burn, so that path re-throws: without it there is no replay defence.
      if (kind === PartnerUsageKind.DIRECT_VERIFIED) throw error
      this.logger.warn(
        `[${this.meterDirect.name}] Could not meter a rejected verification`,
        {
          err: error,
        },
      )
      return true
    }
  }
}

function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  )
}
