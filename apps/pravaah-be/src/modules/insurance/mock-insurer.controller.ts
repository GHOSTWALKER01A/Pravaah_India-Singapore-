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

import { ENV } from '@/constants/environment.constants'
import { httpJson } from '@/common/http/http-client'
import { MOCK_INSURER_ROUTES } from '@/modules/insurance/insurance.route'
import { ResponseBuilder } from '@/utils/response-builder'

/**
 * The mock insurer's own surface — the carrier's side of the integration.
 *
 * These endpoints carry exactly the authority a real insurer's systems have: they can
 * produce a correctly signed callback that moves a claim's recorded status. So they are
 * **refused outright when `NODE_ENV=production`**, the same treatment M4 gives
 * `MockUpiController`. A mock rail reachable against real policies is not a testing
 * convenience, it is an unauthenticated write endpoint.
 *
 * ## Why this exists rather than a test fixture
 *
 * `fire-webhook` sends the callback to OUR OWN webhook route over HTTP, through the real
 * signature verification, the real replay dedupe and the real handler. A unit test that
 * called the handler directly would exercise none of those — and the webhook path is the
 * one place in M5 where a mistake is silently exploitable. Being able to run the genuine
 * path on demand is what makes the claim "swapping in Acko is a credential change"
 * checkable rather than asserted.
 *
 * `sign` returns the header without sending anything, for a client that wants to replay a
 * body by hand from an `.http` file.
 */
@Controller(MOCK_INSURER_ROUTES.BASE)
export class MockInsurerController {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockInsurerController.name })
  }

  /**
   * Fire a correctly signed insurer callback at ourselves.
   *
   * The body is signed with the SAME secret the verifier reads, so this exercises the real
   * path end to end. If the secret is wrong the request comes back 403 — which is the
   * correct and useful outcome, because it means the demo has found a misconfiguration
   * before a real insurer would.
   */
  @Post(MOCK_INSURER_ROUTES.FIRE_WEBHOOK)
  async fireWebhook(@Body() body: Record<string, unknown>) {
    this.assertNotProduction()

    const payload = JSON.stringify(body ?? {})
    const signature = this.sign(payload)
    const url = `${this.baseUrl()}/api/v1/webhooks/insurance/mock-insurer`

    /**
     * The trace label, from the event id only when it is genuinely a scalar.
     *
     * `String(body.eventId)` on an object yields `"[object Object]"`, which would
     * make every malformed callback share one trace id — and the trace id is how a
     * failed delivery is found in the logs afterwards.
     */
    const eventLabel =
      typeof body?.eventId === 'string' || typeof body?.eventId === 'number'
        ? String(body.eventId)
        : 'callback'

    this.logger.warn(
      `[${this.fireWebhook.name}] Firing a signed mock insurer callback`,
      { url, eventId: eventLabel },
    )

    /**
     * The body is sent as the SIGNED STRING, not as an object.
     *
     * Handing axios an object would let it serialise the payload itself, and any
     * difference in key order or spacing from our `JSON.stringify` produces a
     * different message than the one we signed — a 403 that looks like a broken
     * secret and is actually a serialisation mismatch. Sending the exact bytes
     * removes the possibility.
     */
    const result = await httpJson<unknown>(
      {
        method: 'POST',
        url,
        data: payload,
        headers: {
          'content-type': 'application/json',
          'x-insurer-signature': signature,
        },
      },
      `mock-insurer-${eventLabel}`,
    )

    return ResponseBuilder.success(
      {
        url,
        signature,
        delivered: result.ok,
        response: result.ok ? result.value : result.error.message,
      },
      result.ok
        ? 'Callback delivered through the real verification path'
        : 'Callback was rejected — check INSURER_WEBHOOK_SECRET',
    )
  }

  /**
   * Sign a body without sending it.
   *
   * For replaying a callback by hand from an `.http` file or curl. Returns the exact header
   * name and value the verifier expects, and the CANONICAL body string — because the
   * signature covers those exact bytes, and a client that re-serialised the object would
   * produce a different message and a 403 it could not explain.
   */
  @Post(MOCK_INSURER_ROUTES.SIGN)
  sign_(@Body() body: Record<string, unknown>) {
    this.assertNotProduction()

    const payload = JSON.stringify(body ?? {})
    return ResponseBuilder.success(
      {
        header: 'x-insurer-signature',
        signature: this.sign(payload),
        /**
         * Send THESE bytes, exactly.
         *
         * Returned so the caller does not re-serialise the object themselves. Key order and
         * whitespace are part of the signed message; a pretty-printed copy verifies as a
         * different body.
         */
        canonicalBody: payload,
      },
      'Signed. Send `canonicalBody` verbatim with this header.',
    )
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret()).update(payload).digest('hex')
  }

  private secret(): string {
    return (
      this.config.get<string>(ENV.INSURANCE.WEBHOOK_SECRET) ??
      // Matches MockInsurerProvider's own fallback, so the dev path is consistent.
      'mock'
    )
  }

  private baseUrl(): string {
    return (
      this.config.get<string>(ENV.API.PUBLIC_URL)?.replace(/\/+$/, '') ??
      `http://127.0.0.1:${this.config.get<string>(ENV.PORT) ?? '8000'}`
    )
  }

  /**
   * Refuse in production.
   *
   * Checked per request rather than by conditionally registering the controller, because a
   * registration-time check depends on env being loaded before the module graph is built —
   * and a mock insurer that was silently live because a `.env` file loaded a moment late is
   * exactly the failure this guard exists to prevent.
   */
  private assertNotProduction(): void {
    if (this.config.get<string>(ENV.NODE_ENV) === 'production') {
      this.logger.error(
        `[${this.assertNotProduction.name}] Mock insurer endpoint refused in production`,
      )
      throw new ForbiddenException(
        'The mock insurer is not available in production',
      )
    }
  }
}
