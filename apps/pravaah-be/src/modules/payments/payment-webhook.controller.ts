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

import { ResponseBuilder } from '@/utils/response-builder'

import { PAYMENT_WEBHOOK_ROUTES } from '@/modules/payments/payments.route'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { RailEventService } from '@/modules/payments/services/rail-event.service'

import type { Request } from 'express'

/**
 * Rail callbacks.
 *
 * The most security-sensitive route in the module: a request that can settle a payment, arriving
 * unauthenticated from the public internet. Four defences, in the order they apply:
 *
 *  1. **The provider must be one we know.** An unknown `:provider` is rejected before any body
 *     is read, so an attacker cannot pick a verification scheme.
 *  2. **HMAC over the RAW BYTES.** Not over a re-serialised object — `JSON.stringify(req.body)`
 *     reorders keys and drops whitespace, so it verifies a different message than the one that
 *     was signed. That check would fail on every legitimate webhook and would inevitably be
 *     "fixed" by removing it. `rawBody: true` in the bootstrap is what makes this possible.
 *  3. **Replay dedupe** on `(provider, eventId)`, enforced by a unique index rather than a
 *     lookup — a rail that retries its callback must not settle a transaction twice.
 *  4. **The state machine**, which refuses an out-of-order event that would un-settle a payment.
 *
 * The response is deliberately uninformative. A webhook endpoint that reported whether a rail
 * reference was recognised would be an oracle for probing which references exist.
 */
@Controller(PAYMENT_WEBHOOK_ROUTES.BASE)
export class PaymentWebhookController {
  private readonly logger: AppLogger

  constructor(
    private readonly providers: PaymentProviderFactory,
    private readonly railEvents: RailEventService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PaymentWebhookController.name })
  }

  @Post(PAYMENT_WEBHOOK_ROUTES.PROVIDER)
  // 200: an acknowledgement, not a resource. Rails read the STATUS CODE to decide whether to
  // retry, so a 201 or a 204 here changes retry behaviour for no benefit.
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
     * The fallback to a re-serialised body exists only for a misconfigured deployment where
     * `rawBody` is unavailable; it is logged, because a signature verified against
     * re-serialised JSON is a signature that will start failing the moment a rail changes its
     * key order.
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

    const signatureVerified = provider.verifyWebhook(headers, rawBody)
    if (!signatureVerified) {
      this.logger.error(
        `[${this.handle.name}] Rejected a rail webhook with a bad signature`,
        { provider: providerName },
      )
      // 403 and nothing else. An unsigned or wrongly signed callback tells us nothing about
      // whether the payment is real, so it must not be recorded as though it did.
      throw new ForbiddenException('Invalid webhook signature')
    }

    const event = provider.parseWebhook(body)
    if (!event) {
      /**
       * Signed, but unparseable.
       *
       * Answered 200. The signature proves it came from the rail, so retrying it will produce
       * the same unparseable body forever — a non-2xx would have the rail hammering us with a
       * message we can never accept. Logged at error level because it means our parser and
       * their payload have diverged.
       */
      this.logger.error(
        `[${this.handle.name}] Could not parse a signed rail webhook`,
        { provider: providerName },
      )
      return ResponseBuilder.success({ received: true }, 'Received')
    }

    const { outcome } = await this.railEvents.ingest({
      provider: provider.name,
      rawBody,
      signatureVerified,
      event,
    })

    this.logger.info(`[${this.handle.name}] Rail webhook processed`, {
      provider: provider.name,
      kind: event.kind,
      status: event.status,
      outcome,
    })

    // Uniform body regardless of outcome — see the class comment on the oracle risk.
    return ResponseBuilder.success({ received: true }, 'Received')
  }

  /**
   * Resolve the provider before touching the body.
   *
   * An unknown name is a 403, not a 404: distinguishing "no such provider" from "bad signature"
   * would let an attacker enumerate which integrations exist.
   */
  private resolveProvider(name: string) {
    const provider = this.providers
      .all()
      .find((candidate) => candidate.name === name.toLowerCase())
    if (!provider) {
      this.logger.warn(
        `[${this.resolveProvider.name}] Webhook for an unknown provider`,
        { provider: name },
      )
      throw new ForbiddenException('Invalid webhook signature')
    }
    return provider
  }
}
