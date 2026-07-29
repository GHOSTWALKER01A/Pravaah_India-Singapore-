import { createHmac } from 'crypto'

import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { httpJson } from '@/common/http/http-client'
import { ENV } from '@/constants/environment.constants'
import { ResponseBuilder } from '@/utils/response-builder'

import { MOCK_TELCO_ROUTES } from '@/modules/fraud/fraud.route'

/**
 * The mock telco's own surface — the carrier's side of the integration.
 *
 * These endpoints carry exactly the authority a real carrier has: they can produce a
 * correctly signed callback that FREEZES a user's devices for high-value actions. So they
 * are **refused outright when `NODE_ENV=production`**, the same treatment M4 gives
 * `MockUpiController` and M5 gives `MockInsurerController`. A mock carrier reachable
 * against real accounts is an unauthenticated denial-of-service against the payment
 * system.
 *
 * ## Why this exists rather than a unit test
 *
 * `sim-swap` posts to OUR OWN webhook route over HTTP, through the real signature
 * verification, the real replay dedupe and the real handler. A test that called the
 * handler directly would exercise none of those — and the webhook path is the one place in
 * M6 where a mistake is both silent and exploitable in two directions (a forged freeze, or
 * a real swap ignored). Being able to run the genuine path on demand is what makes the
 * SIM-swap demo a demonstration of the control rather than of a fixture.
 */
@Controller(MOCK_TELCO_ROUTES.BASE)
export class MockTelcoController {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockTelcoController.name })
  }

  /**
   * Fire a correctly signed SIM-change callback at ourselves.
   *
   * Signed with the SAME secret the verifier reads, so this exercises the real path end to
   * end. A 403 coming back is the correct and useful outcome — it means the demo found a
   * misconfiguration before a real carrier would.
   */
  @Post(MOCK_TELCO_ROUTES.SIM_SWAP)
  async fireSimSwap(
    @Body() body: { mobile?: string; simSerial?: string; eventId?: string },
  ) {
    this.assertNotProduction()

    const payload = JSON.stringify(body ?? {})
    const { signature, timestamp } = this.sign(payload)
    const url = `${this.baseUrl()}/api/v1/webhooks/fraud/telco/dev-telco`

    this.logger.warn(`[${this.fireSimSwap.name}] Firing a mock SIM-change`, {
      mobile: body.mobile,
    })

    const eventLabel =
      typeof body?.eventId === 'string' ? body.eventId : 'sim-swap'

    const result = await httpJson<unknown>(
      {
        method: 'POST',
        url,
        /**
         * The exact string that was signed is sent as `data`, not the object.
         *
         * Handing axios an object lets it serialise the payload itself, and any
         * difference in key order or spacing from our `JSON.stringify` produces a
         * different message than the one we signed — a 403 that looks like a broken
         * secret and is actually a serialisation mismatch. Sending the exact bytes
         * removes the possibility.
         */
        data: payload,
        headers: {
          'content-type': 'application/json',
          'x-pravaah-signature': signature,
          'x-pravaah-timestamp': String(timestamp),
        },
      },
      `mock-telco-${eventLabel}`,
    )

    return ResponseBuilder.success(
      {
        url,
        delivered: result.ok,
        response: result.ok ? result.value : result.error.message,
      },
      result.ok
        ? 'SIM-change callback delivered through the real verification path'
        : 'Callback was rejected — check TELCO_WEBHOOK_SECRET',
    )
  }

  /** Sign a body without sending it, so a client can replay it from an `.http` file. */
  @Post(MOCK_TELCO_ROUTES.SIGN)
  signOnly(@Body() body: Record<string, unknown>) {
    this.assertNotProduction()

    const payload = JSON.stringify(body ?? {})
    const { signature, timestamp } = this.sign(payload)

    return ResponseBuilder.success(
      {
        'x-pravaah-signature': signature,
        'x-pravaah-timestamp': String(timestamp),
        body: payload,
        note: 'Send exactly this body string — re-serialising it invalidates the signature',
      },
      'Signed',
    )
  }

  /**
   * Sign over `${timestamp}.${rawBody}`, matching `verifyHmacWebhook`.
   *
   * The timestamp is inside the signed material, not merely alongside it. If it were only
   * a header, an attacker could replay a captured body with a fresh timestamp and pass
   * the freshness window — which would defeat the entire point of having one.
   */
  private sign(payload: string): { signature: string; timestamp: number } {
    const timestamp = Date.now()
    const signature = createHmac('sha256', this.secret())
      .update(`${timestamp}.${payload}`)
      .digest('hex')
    return { signature, timestamp }
  }

  private secret(): string {
    return (
      this.config.get<string>(ENV.FRAUD.TELCO_WEBHOOK_SECRET) ??
      this.config.get<string>(ENV.CRYPTO.FIELD_ENCRYPTION_KEY) ??
      ''
    )
  }

  private baseUrl(): string {
    return (
      this.config.get<string>(ENV.API.PUBLIC_URL)?.replace(/\/+$/, '') ??
      'http://localhost:8000'
    )
  }

  /**
   * Refuse in production.
   *
   * Checked per request rather than at module load, because `NODE_ENV` is read through
   * `ConfigService` (which has loaded the `.env.*.local` files) and a load-time check
   * would evaluate before those are read — silently leaving the mock enabled in exactly
   * the environment it must not be.
   */
  private assertNotProduction(): void {
    if (this.config.get<string>(ENV.NODE_ENV) === 'production') {
      throw new ForbiddenException(
        'The mock telco is not available in production',
      )
    }
  }
}
