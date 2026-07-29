import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { INSURANCE_WEBHOOK_ROUTES } from '@/modules/insurance/insurance.route'
import { InsuranceProviderRegistry } from '@/modules/insurance/providers/insurance-provider.registry'
import type { InsurerWebhookEvent } from '@/modules/insurance/providers/insurer.provider'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import { ResponseBuilder } from '@/utils/response-builder'

import { ActorType, ClaimStatus } from 'generated/prisma/client'

import type { Request } from 'express'

/**
 * Insurer callbacks.
 *
 * The most security-sensitive route in M5: an unauthenticated request from the public
 * internet that can move a claim's status. Four defences, in the order they apply — the
 * same structure M4's rail webhook uses, because the threat is the same:
 *
 *  1. **The provider must be one we know.** An unknown `:provider` is rejected before any
 *     body is read, so an attacker cannot choose which verification scheme applies to
 *     their payload.
 *  2. **HMAC over the RAW BYTES.** Not over a re-serialised object —
 *     `JSON.stringify(req.body)` reorders keys and drops whitespace, so it verifies a
 *     different message than the one that was signed. That check fails on every
 *     legitimate webhook and inevitably gets "fixed" by deleting it. `rawBody: true` in
 *     the bootstrap is what makes this possible.
 *  3. **Replay dedupe** on `(provider, eventId)`, by unique index rather than a lookup. An
 *     insurer that retries its callback must not adjudicate a claim twice.
 *  4. **The state machine**, which refuses an out-of-order event.
 *
 * ## What an insurer's verdict is allowed to do
 *
 * Read carefully, because the answer is narrower than it looks. An insurer's `APPROVED`
 * does NOT auto-pay a claim, and their `REJECTED` does not reverse one we have already
 * paid. In this build OUR adjudication is authoritative — we carry the demo risk — so a
 * callback RECORDS the insurer's position and, at most, adds it to the reviewer's picture.
 *
 * That is the honest arrangement rather than a limitation. When a licensed insurer
 * actually carries the risk, their adjudication becomes authoritative and this handler
 * gains the branch that acts on it; wiring that branch now, against a mock, would mean a
 * demonstration insurer could move real money.
 *
 * The response is deliberately uninformative. A webhook endpoint that reported whether a
 * claim reference was recognised would be an oracle for probing which claims exist.
 */
@Controller(INSURANCE_WEBHOOK_ROUTES.BASE)
export class InsuranceWebhookController {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: InsuranceProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: InsuranceWebhookController.name })
  }

  @Post(INSURANCE_WEBHOOK_ROUTES.PROVIDER)
  // 200: an acknowledgement, not a resource. Insurers read the STATUS CODE to decide
  // whether to retry, so a 201 or 204 here changes retry behaviour for no benefit.
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('provider') providerName: string,
    @Headers() headers: Record<string, unknown>,
    @Body() body: unknown,
    @Req() request: Request & { rawBody?: Buffer },
  ) {
    const provider = this.resolveProvider(providerName)

    /**
     * Sign over the exact bytes received.
     *
     * The fallback to a re-serialised body exists only for a misconfigured deployment
     * where `rawBody` is unavailable, and it is logged — a signature verified against
     * re-serialised JSON will start failing the moment an insurer changes their key order.
     */
    let rawBody: string
    if (request.rawBody) {
      rawBody = request.rawBody.toString('utf8')
    } else {
      rawBody = JSON.stringify(body ?? {})
      this.logger.warn(
        `[${this.handle.name}] Raw body unavailable — verifying against re-serialised JSON`,
        { provider: providerName },
      )
    }

    if (!provider.verifyWebhook(headers, rawBody)) {
      this.logger.error(
        `[${this.handle.name}] Rejected an insurer callback with a bad signature`,
        { provider: providerName },
      )
      // 403 and nothing else. An unsigned or wrongly signed callback tells us nothing
      // about whether the claim is real, so it must not be recorded as though it did.
      throw new ForbiddenException('Invalid webhook signature')
    }

    const event = provider.parseWebhook(body)
    if (!event) {
      /**
       * Signed, but unparseable.
       *
       * Answered 200. The signature proves it came from the insurer, so retrying will
       * produce the same unparseable body for ever — a non-2xx would have them hammering us
       * with a message we can never accept. Logged at error level because it means our
       * parser and their payload have diverged.
       */
      this.logger.error(
        `[${this.handle.name}] Could not parse a signed insurer callback`,
        { provider: providerName },
      )
      return ResponseBuilder.success({ received: true }, 'Received')
    }

    /**
     * Replay dedupe, by unique index.
     *
     * `create`-then-catch rather than a lookup, because two copies of one retry arriving
     * together both find nothing and both proceed. Only the constraint can arbitrate.
     */
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: provider.name, eventId: event.eventId },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.info(
          `[${this.handle.name}] Duplicate insurer callback ignored`,
          { provider: provider.name, eventId: event.eventId },
        )
        return ResponseBuilder.success({ received: true }, 'Received')
      }
      throw error
    }

    await this.record(provider.name, event)
    return ResponseBuilder.success({ received: true }, 'Received')
  }

  /**
   * Record the insurer's position against the claim.
   *
   * RECORD, not act. The insurer's reference and their status are stored and audited so a
   * reviewer can see what the carrier thinks, and so a future build in which the carrier
   * is authoritative has the data path already in place. Nothing here moves money or
   * closes a claim.
   *
   * The one exception is a claim we have NOT yet decided: an insurer's REJECTED on such a
   * claim is added to the audit trail as a signal for the reviewer, and even then it does
   * not change the status. A mock insurer must never be able to reject somebody's claim.
   */
  private async record(
    providerName: string,
    event: InsurerWebhookEvent,
  ): Promise<void> {
    if (event.kind === 'POLICY_STATUS') {
      if (!event.insurerPolicyRef) return
      const policy = await this.prisma.policy.findFirst({
        where: { insurerPolicyRef: event.insurerPolicyRef },
        select: { id: true, policyNumber: true },
      })
      if (!policy) {
        this.logger.warn(
          `[${this.record.name}] Policy callback for an unknown reference`,
          { provider: providerName, ref: event.insurerPolicyRef },
        )
        return
      }

      await this.audit.log({
        actorType: ActorType.SYSTEM,
        action: 'insurance.insurer.policy_status',
        entity: 'Policy',
        entityId: policy.id,
        metadata: {
          provider: providerName,
          status: event.status,
          reason: event.reason,
          eventId: event.eventId,
        },
      })
      return
    }

    if (!event.insurerClaimRef) return
    const claim = await this.prisma.claim.findFirst({
      where: { insurerClaimRef: event.insurerClaimRef },
      select: { id: true, claimNumber: true, status: true },
    })
    if (!claim) {
      /**
       * A claim reference we do not recognise.
       *
       * Logged and dropped. NOT reported back to the caller — distinguishing "no such
       * claim" from "accepted" would let somebody enumerate which claim references exist
       * by watching the response.
       */
      this.logger.warn(
        `[${this.record.name}] Claim callback for an unknown reference`,
        { provider: providerName, ref: event.insurerClaimRef },
      )
      return
    }

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'insurance.insurer.claim_status',
      entity: 'Claim',
      entityId: claim.id,
      metadata: {
        provider: providerName,
        claimNumber: claim.claimNumber,
        insurerStatus: event.status,
        insurerApprovedMinor: event.approvedMinor?.toString() ?? null,
        reason: event.reason,
        // Our own status, recorded alongside, so the audit line shows whether the
        // carrier and we agreed at that moment.
        ourStatus: claim.status,
        eventId: event.eventId,
      },
    })

    if (
      event.status === 'REJECTED' &&
      (claim.status === ClaimStatus.SUBMITTED ||
        claim.status === ClaimStatus.UNDER_REVIEW)
    ) {
      /**
       * The carrier disagrees with a claim we have not decided yet.
       *
       * Escalated in the log for the reviewer's attention, and nothing more. A callback
       * that could reject an undecided claim would let whoever holds the webhook secret
       * refuse somebody's claim without a human ever seeing it.
       */
      this.logger.warn(
        `[${this.record.name}] Insurer reports REJECTED on a claim still under review — for the reviewer's attention`,
        { claimId: claim.id, claimNumber: claim.claimNumber },
      )
    }
  }

  /**
   * Resolve the provider before touching the body.
   *
   * An unknown name is a 403, not a 404: distinguishing "no such provider" from "bad
   * signature" would let an attacker enumerate which integrations exist.
   */
  private resolveProvider(name: string) {
    const provider = this.registry
      .allInsurers()
      .find((candidate) => candidate.name === name.toLowerCase())
    if (!provider) {
      this.logger.warn(
        `[${this.resolveProvider.name}] Callback for an unknown insurer`,
        { provider: name },
      )
      throw new ForbiddenException('Invalid webhook signature')
    }
    return provider
  }
}
