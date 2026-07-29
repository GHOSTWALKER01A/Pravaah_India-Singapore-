import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'
import { ResponseBuilder } from '@/utils/response-builder'

import { FRAUD_WEBHOOK_ROUTES } from '@/modules/fraud/fraud.route'
import { FraudProviderRegistry } from '@/modules/fraud/providers/fraud-provider.registry'
import { hashSimSerial } from '@/modules/fraud/risk-hash.util'
import { DeviceTrustService } from '@/modules/fraud/services/device-trust.service'

/** What a carrier sends. Kept loose — we validate what we use, not their whole schema. */
interface TelcoSimChangePayload {
  eventId?: string
  /** The subscriber number, E.164. */
  mobile?: string
  /** The new SIM serial, if the carrier shares it. */
  simSerial?: string
  changedAt?: string
}

/**
 * Telco SIM-change callbacks.
 *
 * ## Why this endpoint is security-critical in BOTH directions
 *
 * It can move a device into `SUSPECTED_SWAP`, which freezes high-value actions. That
 * makes it powerful in two opposite ways, and the design has to respect both:
 *
 *  - **Unauthenticated, it is a denial-of-service.** Anybody who can POST here could
 *    freeze any user's payments by naming their number. So the HMAC signature over the
 *    RAW bytes is not ceremony — it is the only thing standing between a public URL and
 *    an attacker-controlled kill switch on the payment system.
 *  - **Ignored, a real fraud control is switched off.** A swap we never hear about is a
 *    swap the OTP layer no longer defends against. So an unverifiable callback is
 *    refused LOUDLY rather than dropped quietly.
 *
 * ## Mounted outside every prefixed group, on purpose
 *
 * A carrier has no JWT. A webhook route that silently inherited a session guard would
 * fail every SIM-change notification with a 401 nobody was watching — a fraud control
 * that reports success while being off. This is the same reasoning M4's and M5's webhook
 * controllers document.
 */
@Controller(FRAUD_WEBHOOK_ROUTES.BASE)
export class FraudWebhookController {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: FraudProviderRegistry,
    private readonly devices: DeviceTrustService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: FraudWebhookController.name })
  }

  @Post(FRAUD_WEBHOOK_ROUTES.TELCO)
  async simChange(
    @Param('provider') providerName: string,
    @Headers() headers: Record<string, string>,
    @Body() body: TelcoSimChangePayload,
    @Req() req: { rawBody?: Buffer | string },
  ) {
    const provider = this.providers.telcoByName(providerName)

    /**
     * An unknown provider is a flat 403, not a 500.
     *
     * The provider name comes from an UNAUTHENTICATED caller's URL, so a probe for
     * `/webhooks/fraud/telco/anything` must not produce a stack trace in the logs or
     * reveal which names are valid.
     */
    if (!provider) {
      this.logger.warn(
        `[${this.simChange.name}] Callback for an unknown telco provider`,
        { providerName },
      )
      throw new ForbiddenException('Unknown provider')
    }

    /**
     * The RAW bytes, never `JSON.stringify(body)` when the raw form is available.
     *
     * Re-serialising a parsed body re-orders keys and normalises whitespace, so a
     * signature computed over the original payload will not match one computed over the
     * copy. `rawBody: true` in `main.ts` is what makes the raw form available; the
     * re-serialised fallback exists only for a transport that lost it, and it is LOGGED,
     * because a signature verified against a reconstructed body is a signature nobody
     * should trust silently.
     */
    let rawBody: string
    if (req.rawBody) {
      rawBody = req.rawBody.toString('utf8')
    } else {
      rawBody = JSON.stringify(body ?? {})
      this.logger.warn(
        `[${this.simChange.name}] rawBody unavailable — verifying against a re-serialised body`,
        { providerName },
      )
    }

    if (!provider.verifyWebhook(headers, rawBody)) {
      this.logger.warn(
        `[${this.simChange.name}] Rejected an unsigned or mis-signed telco callback`,
        { providerName },
      )
      throw new ForbiddenException('Bad signature')
    }

    if (!body.mobile) {
      // Nothing actionable. A 200 so the carrier does not retry forever.
      return ResponseBuilder.success(
        { ok: true, applied: false },
        'No subscriber number in the callback',
      )
    }

    /**
     * Replay dedupe, reusing M0's `WebhookEvent` table.
     *
     * One unique index on `(provider, eventId)` is easier to trust than a second table
     * — the same choice M5 made. The `create` is the CHECK: if it violates the
     * constraint, this event has already been processed, and the answer is a success
     * rather than an error because a carrier retrying a delivery it never got
     * acknowledged is correct behaviour on their part.
     *
     * The synthetic fallback key matters: a carrier that omits `eventId` would otherwise
     * bypass dedupe entirely, and replaying a SIM-change notification is a free way to
     * re-freeze a device the user just recovered.
     */
    const eventId = body.eventId ?? `${body.mobile}:${body.simSerial ?? 'none'}`

    try {
      await this.prisma.webhookEvent.create({
        data: { provider: `telco:${providerName}`, eventId },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return ResponseBuilder.success(
          { ok: true, duplicate: true },
          'Already processed',
        )
      }
      throw error
    }

    /**
     * Fan out across every device on the account.
     *
     * The carrier names a NUMBER; it has no idea which handsets we bound. A swap
     * invalidates all of them equally, so checking only the most recent would leave an
     * attacker acting from an older bound device.
     */
    const devices = await this.devices.devicesForMobile(body.mobile)

    if (devices.length === 0) {
      return ResponseBuilder.success(
        { ok: true, applied: false },
        'No bound devices for that number',
      )
    }

    const mobileHash = this.devices.mobileHashFor(body.mobile)
    const presentedHash = body.simSerial
      ? hashSimSerialSafe(body.simSerial)
      : null

    let flagged = 0
    for (const device of devices) {
      const result = await this.devices.detectSimSwap({
        deviceRef: device.id,
        mobileHash,
        /**
         * When the carrier withheld the new serial, the STORED one is presented.
         *
         * The anchor comparison then trivially agrees, so the decision rests entirely on
         * the carrier's own verdict — which is correct: they told us the number was
         * re-issued, and that is the fact we are acting on.
         */
        presentedSimSerialHash: presentedHash ?? device.simSerialHash,
        source: 'webhook',
      })
      if (result.suspected) flagged += 1
    }

    this.logger.warn(
      `[${this.simChange.name}] Processed a SIM-change callback`,
      { providerName, devices: devices.length, flagged },
    )

    return ResponseBuilder.success(
      { ok: true, devices: devices.length, flagged },
      flagged > 0
        ? 'Devices frozen pending re-verification'
        : 'No change required',
    )
  }
}

/**
 * Hash a carrier-supplied serial without letting a configuration error 500 the endpoint.
 *
 * `hashSimSerial` throws when no hashing key is configured. A throw here would surface
 * as a 500 on an UNAUTHENTICATED route, which turns a misconfiguration into an
 * observable difference an attacker can probe for. Returning `null` degrades to the
 * carrier-verdict-only path above — still a working control, just without the anchor
 * comparison.
 */
function hashSimSerialSafe(serial: string): string | null {
  try {
    return hashSimSerial(serial)
  } catch {
    return null
  }
}
