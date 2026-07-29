import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type { DeviceContextDto } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { isUniqueViolation } from '@/utils/prisma-error.util'

import {
  DEVICE_COOLING_OFF_MS,
  MAX_ACTIVE_DEVICES,
  MAX_BIND_ATTEMPTS,
  SIGNAL_WEIGHTS,
} from '@/modules/fraud/fraud.config'
import {
  canDeviceTransition,
  isDeviceTrustedForValue,
  type Signal,
} from '@/modules/fraud/fraud.state'
import { FraudProviderRegistry } from '@/modules/fraud/providers/fraud-provider.registry'
import {
  hashIpNetwork,
  hashMobile,
  hashSimSerial,
} from '@/modules/fraud/risk-hash.util'
import type { RiskContext } from '@/modules/fraud/risk.types'

import {
  ActorType,
  DeviceEventType,
  DeviceStatus,
  type Device,
  type Prisma,
} from 'generated/prisma/client'

/** What `bind` hands back — a challenge, deliberately never a token. */
export interface BindTicket {
  deviceRef: string
  status: DeviceStatus
  /** Set when the device is already bound and nothing further is needed. */
  alreadyBound: boolean
}

/**
 * Device binding, SIM-swap detection, and the trust signals that follow from both.
 *
 * ## Why this service exists at all
 *
 * M0 defined the `Device` model and M4 reads it, but **nothing in the codebase ever
 * wrote a row to it**. `PaymentRiskService`'s device checks were therefore dead
 * code: every lookup missed, every transfer scored as `UNKNOWN_DEVICE`, and the
 * SIM-swap branch could not fire because no serial had ever been stored. M6 owns
 * that lifecycle now, which turns three of M4's existing signals from aspiration
 * into working controls.
 *
 * ## The two layers, and why they are independent
 *
 * The threat is an account takeover, and it has two halves that must be defeated
 * separately (T1, T2):
 *
 *  1. **The attacker needs a device.** Binding one is cheap — a single step-up — but
 *     binding STARTS A COOLING-OFF CLOCK during which high-value actions face extra
 *     scrutiny. So an attacker who phishes credentials and binds their own handset
 *     still hits a wall on the first large transfer.
 *  2. **The attacker needs the OTP.** A SIM swap gets them that, which is why the
 *     SIM serial is anchored at bind time and compared on every check. A swap moves
 *     the device to `SUSPECTED_SWAP` and freezes it for value.
 *
 * Defeating one does not defeat the other. That independence is the whole design —
 * and it is why the control still works with a stub telco behind it, because the
 * serial comparison is against OUR anchor, not the carrier's record.
 */
@Injectable()
export class DeviceTrustService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: FraudProviderRegistry,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: DeviceTrustService.name })
  }

  // ── resolution ────────────────────────────────────────────────────────────
  /**
   * Find the `Device` row for a client-supplied device id.
   *
   * The single place that translation happens. Every other module holds the
   * client's uuid; only M6 knows how it maps to a row, which means a change to that
   * mapping (a hash, a composite key) is one file rather than five.
   */
  resolve(userId: string, clientDeviceId: string): Promise<Device | null> {
    return this.prisma.device.findUnique({
      where: { userId_deviceId: { userId, deviceId: clientDeviceId } },
    })
  }

  listForUser(userId: string) {
    return this.prisma.device.findMany({
      where: { userId, status: { not: DeviceStatus.REVOKED } },
      select: {
        id: true,
        deviceId: true,
        platform: true,
        status: true,
        integrity: true,
        coolingOffUntil: true,
        boundAt: true,
        lastSeenAt: true,
        createdAt: true,
        swapDetectedAt: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    })
  }

  // ── the collector ─────────────────────────────────────────────────────────
  /**
   * Device trust signals for one action.
   *
   * READ-ONLY apart from a `lastSeenAt` touch, so it is safe to call on the hot
   * payment path. Every branch returns a WEIGHTED signal rather than a verdict —
   * except a revoked device, which is hard. That asymmetry is deliberate: "this
   * device is unfamiliar" is a probability, whereas "the account holder told us this
   * device was stolen" is a fact, and averaging a theft report against a good payment
   * history is how a thief gets paid.
   */
  async signals(ctx: RiskContext): Promise<Signal[]> {
    if (!ctx.clientDeviceId) {
      /**
       * No device id at all.
       *
       * Scored, not refused. Several legitimate callers have none — a web session, a
       * scheduled mandate debit, an admin-initiated action. Refusing here would break
       * those; scoring it means a sensitive action without a device still gets
       * challenged by the ladder's structural rule.
       */
      return [
        {
          type: 'DEVICE_UNBOUND',
          weight: SIGNAL_WEIGHTS.DEVICE_UNBOUND,
          value: 1,
          reason: 'This action did not come from a registered device',
        },
      ]
    }

    const device = await this.resolve(ctx.userId, ctx.clientDeviceId)

    if (!device) {
      return [
        {
          type: 'DEVICE_UNBOUND',
          weight: SIGNAL_WEIGHTS.DEVICE_UNBOUND,
          value: 1,
          reason: 'This device is not registered to the account',
        },
      ]
    }

    if (device.status === DeviceStatus.REVOKED) {
      return [
        {
          type: 'REVOKED_DEVICE',
          weight: SIGNAL_WEIGHTS.REVOKED_DEVICE,
          value: 1,
          reason: 'This device was removed from the account',
          isHard: true,
        },
      ]
    }

    const out: Signal[] = []

    /**
     * `BINDING` never passed its challenge, so it is not a bound device — it is a
     * bind attempt someone abandoned, or one an attacker started and is now trying
     * to act from.
     */
    if (device.status === DeviceStatus.BINDING) {
      out.push({
        type: 'DEVICE_UNBOUND',
        weight: SIGNAL_WEIGHTS.DEVICE_UNBOUND,
        value: 1,
        reason: 'This device has not finished being registered',
      })
    }

    if (device.status === DeviceStatus.SUSPECTED_SWAP) {
      out.push({
        type: 'SIM_SUSPECTED_SWAP',
        weight: SIGNAL_WEIGHTS.SIM_SUSPECTED_SWAP,
        value: 1,
        reason: 'A possible SIM change was detected on this device',
      })
    }

    // ── cooling-off ──
    const coolingOff = device.coolingOffUntil
    if (coolingOff && coolingOff > new Date()) {
      const remaining = coolingOff.getTime() - Date.now()
      out.push({
        type: 'DEVICE_NEW',
        weight: SIGNAL_WEIGHTS.DEVICE_NEW,
        /**
         * Degree DECAYS across the window.
         *
         * A device bound 30 seconds ago is far more suspicious than one bound 23
         * hours ago, and a flat weight would treat them identically — either
         * challenging everybody on day one or nobody in minute one.
         */
        value: Math.min(1, remaining / DEVICE_COOLING_OFF_MS),
        reason: 'This device was registered recently',
      })
    }

    // ── integrity (T9) ──
    if (device.integrity === 'ROOTED' || device.integrity === 'EMULATOR') {
      out.push({
        type: 'DEVICE_INTEGRITY',
        weight: SIGNAL_WEIGHTS.DEVICE_INTEGRITY,
        value: 1,
        reason:
          device.integrity === 'EMULATOR'
            ? 'This app is running on an emulator'
            : 'This device appears to be rooted or jailbroken',
      })
    } else if (device.integrity === 'UNKNOWN') {
      /**
       * No verdict is not a pass.
       *
       * Weighted low (0.10) but present, because "the client did not run the check"
       * is exactly what an attacker's client reports. Treating a missing verdict as
       * OK would let anyone opt out of integrity checking by omitting a field.
       */
      out.push({
        type: 'DEVICE_INTEGRITY_UNKNOWN',
        weight: SIGNAL_WEIGHTS.DEVICE_INTEGRITY_UNKNOWN,
        value: 1,
        reason: 'This device did not report a security check',
      })
    }

    /**
     * No SIM anchor was ever captured, so swap detection is BLIND for this device.
     *
     * Common and often innocent — iOS does not expose the ICCID, and a web client
     * has no SIM. But a device we cannot swap-check is a device with one fewer layer,
     * and the score should say so rather than silently assuming the layer is present.
     */
    if (!device.simSerialHash && device.platform !== 'web') {
      out.push({
        type: 'SIM_UNVERIFIABLE',
        weight: SIGNAL_WEIGHTS.SIM_UNVERIFIABLE,
        value: 1,
        reason: 'SIM-change detection is unavailable on this device',
      })
    }

    void this.touch(device.id)
    return out
  }

  /**
   * Whether a device may move significant value without a challenge.
   *
   * Exposed for callers that want the boolean without a full score — M4's
   * pre-flight, for instance. Pure delegation to `fraud.state` so the rule has one
   * definition.
   */
  async isTrustedForValue(
    userId: string,
    clientDeviceId?: string | null,
  ): Promise<boolean> {
    if (!clientDeviceId) return false
    const device = await this.resolve(userId, clientDeviceId)
    if (!device) return false
    return isDeviceTrustedForValue(device.status, device.coolingOffUntil)
  }

  // ── binding ───────────────────────────────────────────────────────────────
  /**
   * Begin binding a device. Returns a ticket, never a credential.
   *
   * Idempotent on `(userId, deviceId)`: re-binding an already-`ACTIVE` device is a
   * no-op that reports `alreadyBound`, because an app that reinstalled and kept its
   * installation id should not be forced through a challenge it already passed. A
   * `REVOKED` device is the exception — it must bind afresh, producing a NEW
   * cooling-off window, because reviving the old row would silently restore a device
   * whose history includes a theft report.
   */
  async beginBind(
    userId: string,
    context: DeviceContextDto,
    meta: { ipAddress?: string | null } = {},
  ): Promise<BindTicket> {
    const existing = await this.resolve(userId, context.deviceId)

    if (existing && existing.status === DeviceStatus.ACTIVE) {
      await this.touch(existing.id)
      return {
        deviceRef: existing.id,
        status: existing.status,
        alreadyBound: true,
      }
    }

    if (existing && existing.failedBindAttempts >= MAX_BIND_ATTEMPTS) {
      /**
       * Locked out.
       *
       * A bind is an authentication surface, so it gets a lockout like any other.
       * Without one, an attacker holding a stolen session token can grind the bind
       * challenge indefinitely.
       */
      this.logger.warn(
        `[${this.beginBind.name}] Refusing a bind on a locked-out device`,
        { userId, deviceRef: existing.id },
      )
      throw new ForbiddenException(
        'Too many failed attempts to register this device. Contact support to continue.',
      )
    }

    await this.assertDeviceSlotAvailable(userId, existing?.id)

    const simSerialHash = context.simSerial
      ? hashSimSerial(context.simSerial)
      : null

    if (existing) {
      const updated = await this.prisma.device.update({
        where: { id: existing.id },
        data: {
          status: DeviceStatus.BINDING,
          platform: context.platform,
          integrity: context.integrity,
          simSerialHash,
        },
      })
      await this.recordEvent({
        userId,
        deviceRef: updated.id,
        type: DeviceEventType.BIND,
        simSerialHash,
        integrity: context.integrity,
        ipAddress: meta.ipAddress,
        geoHint: context.geoHint,
      })
      return {
        deviceRef: updated.id,
        status: updated.status,
        alreadyBound: false,
      }
    }

    try {
      const created = await this.prisma.device.create({
        data: {
          userId,
          deviceId: context.deviceId,
          platform: context.platform,
          integrity: context.integrity,
          simSerialHash,
          status: DeviceStatus.BINDING,
          /**
           * A placeholder, replaced by a real hash on `completeBind`.
           *
           * The column is non-nullable and there is genuinely no token yet — the
           * challenge has not been answered. An empty string cannot be presented as a
           * valid token because `verifyBindingToken` compares against a hash and an
           * empty hash matches nothing.
           */
          bindingTokenHash: '',
        },
      })

      await this.recordEvent({
        userId,
        deviceRef: created.id,
        type: DeviceEventType.BIND,
        simSerialHash,
        integrity: context.integrity,
        ipAddress: meta.ipAddress,
        geoHint: context.geoHint,
      })

      return {
        deviceRef: created.id,
        status: created.status,
        alreadyBound: false,
      }
    } catch (error) {
      /**
       * Two concurrent binds of the same device id. Not an error — the loser reads
       * the winner's row. Safe here because this is NOT inside a transaction; see
       * the warning on `isUniqueViolation`.
       */
      if (isUniqueViolation(error)) {
        const raced = await this.resolve(userId, context.deviceId)
        if (raced) {
          return {
            deviceRef: raced.id,
            status: raced.status,
            alreadyBound: raced.status === DeviceStatus.ACTIVE,
          }
        }
      }
      throw error
    }
  }

  /**
   * Finish a bind after its challenge passed, issuing the binding token.
   *
   * Called ONLY by `StepUpService` on a verified challenge. The token is returned
   * once and stored as a hash, so a database reader cannot present it — the same
   * discipline as an OTP.
   */
  async completeBind(
    deviceRef: string,
    tokenHash: string,
    meta: { ipAddress?: string | null; geoHint?: string | null } = {},
  ): Promise<Device> {
    const device = await this.load(deviceRef)

    if (!canDeviceTransition(device.status, DeviceStatus.ACTIVE)) {
      throw new ConflictException(
        `A ${device.status.toLowerCase()} device cannot be activated`,
      )
    }

    const now = new Date()
    const updated = await this.prisma.device.update({
      where: { id: deviceRef },
      data: {
        status: DeviceStatus.ACTIVE,
        bindingTokenHash: tokenHash,
        tokenRotatedAt: now,
        boundAt: device.boundAt ?? now,
        /**
         * The cooling-off clock starts HERE, not at `beginBind`.
         *
         * Starting it at the attempt would let an attacker begin a bind, wait out the
         * 24 hours, and then answer the challenge against an already-expired window.
         */
        coolingOffUntil: new Date(now.getTime() + DEVICE_COOLING_OFF_MS),
        failedBindAttempts: 0,
        swapDetectedAt: null,
      },
    })

    await this.recordEvent({
      userId: device.userId,
      deviceRef,
      type: DeviceEventType.BIND,
      simSerialHash: device.simSerialHash,
      integrity: device.integrity,
      ipAddress: meta.ipAddress,
      geoHint: meta.geoHint,
      metadata: { activated: true },
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: device.userId,
      action: 'device.bound',
      entity: 'Device',
      entityId: deviceRef,
      metadata: { platform: device.platform, integrity: device.integrity },
      ipAddress: meta.ipAddress ?? null,
    })

    return updated
  }

  async recordBindFailure(deviceRef: string): Promise<void> {
    const device = await this.prisma.device.update({
      where: { id: deviceRef },
      data: { failedBindAttempts: { increment: 1 } },
    })

    await this.recordEvent({
      userId: device.userId,
      deviceRef,
      type: DeviceEventType.BIND_FAILED,
      metadata: { attempts: device.failedBindAttempts },
    })
  }

  /**
   * Rotate a device's binding token, returning the new one ONCE.
   *
   * Why bother: a token that never changes has the useful life of the account. With
   * rotation, a token captured from a log, a backup or a compromised handset stops
   * working at the next refresh — which bounds the damage of a leak nobody detected.
   * `FraudSchedulerService.flagStaleTokens` marks devices past `BINDING_TOKEN_TTL_MS`
   * so the app knows to call this.
   *
   * ## Why the token is generated HERE rather than by the controller
   *
   * So the plaintext exists in exactly one place and only its hash is ever persisted —
   * the same discipline `completeBind` applies. A controller that generated its own
   * token would be a second place to get that wrong, and a binding token readable from
   * a database backup is a device binding an attacker can assume without the handset.
   *
   * ## Why only an ACTIVE device may rotate
   *
   * A `SUSPECTED_SWAP` device must go through `recover` (which costs a step-up and
   * re-anchors the SIM), not quietly refresh its credential. Letting a swap-suspected
   * device rotate would hand an attacker who had just swapped the SIM a fresh token and
   * a clean audit line — which is the entire attack, completed through the maintenance
   * endpoint.
   */
  async rotateToken(
    userId: string,
    deviceRef: string,
  ): Promise<{ bindingToken: string; rotatedAt: Date }> {
    const bindingToken = randomBytes(32).toString('base64url')
    const rotatedAt = new Date()

    const updated = await this.prisma.device.updateMany({
      where: { id: deviceRef, userId, status: DeviceStatus.ACTIVE },
      data: {
        bindingTokenHash: createHash('sha256')
          .update(bindingToken, 'utf8')
          .digest('hex'),
        tokenRotatedAt: rotatedAt,
      },
    })

    /**
     * Scoped to the user AND to ACTIVE, so a device id from another account — or a
     * revoked one — matches zero rows. A 404 rather than a 403: confirming the device
     * exists would let somebody enumerate other people's device ids.
     */
    if (updated.count === 0) {
      throw new NotFoundException('No active device to refresh')
    }

    await this.recordEvent({
      userId,
      deviceRef,
      type: DeviceEventType.TOKEN_REFRESH,
    })

    return { bindingToken, rotatedAt }
  }

  /**
   * Restart the cooling-off window on every one of a user's live devices.
   *
   * ## Why this exists, and why it applies to ALL devices
   *
   * It is the price of the PIN-reset path. A reset proved only by SMS OTP would hand the
   * stolen-phone attacker a bypass: read the code, reset the PIN, pay. Restarting the
   * cooling-off means the risk ladder sees `DEVICE_NEW` on their actions for the next 24 hours,
   * so high-value transfers are challenged or held for an analyst. "Reset and drain" becomes
   * "reset, then wait while somebody reviews it".
   *
   * Applied to every ACTIVE device rather than only the one that reset, because an attacker who
   * had already bound a second device would otherwise just switch to it — cooling off only the
   * device in their hand would be a control that names its own workaround.
   *
   * `SUSPECTED_SWAP` devices are included: they are already frozen for value, and extending
   * their window costs nothing while keeping the arithmetic uniform.
   */
  async restartCoolingOff(userId: string): Promise<number> {
    const updated = await this.prisma.device.updateMany({
      where: {
        userId,
        status: { in: [DeviceStatus.ACTIVE, DeviceStatus.SUSPECTED_SWAP] },
      },
      data: {
        coolingOffUntil: new Date(Date.now() + DEVICE_COOLING_OFF_MS),
      },
    })

    if (updated.count > 0) {
      this.logger.warn(
        `[${this.restartCoolingOff.name}] Cooling-off restarted on ${updated.count} device(s)`,
        { userId },
      )
    }

    return updated.count
  }

  // ── revocation ────────────────────────────────────────────────────────────
  /**
   * Remove a device. The self-service ATO defence.
   *
   * Never requires a step-up, and that is a deliberate asymmetry: revoking is the
   * SAFE direction. A user who suspects a compromise must be able to act instantly,
   * and demanding an OTP from somebody whose SIM was just swapped would deny them the
   * one control that helps. Binding is what costs a challenge.
   *
   * `updateMany` scoped to the user, so a device id from another account matches zero
   * rows rather than revoking a stranger's phone.
   */
  async revoke(params: {
    userId: string
    deviceRef: string
    actor: { type: ActorType; id?: string | null }
    reason: string
    ipAddress?: string | null
  }): Promise<void> {
    const revoked = await this.prisma.device.updateMany({
      where: {
        id: params.deviceRef,
        userId: params.userId,
        status: { not: DeviceStatus.REVOKED },
      },
      data: {
        status: DeviceStatus.REVOKED,
        revokedAt: new Date(),
        revokedReason: params.reason.slice(0, 200),
        // Cleared so a re-bind cannot inherit a stale token hash.
        bindingTokenHash: '',
      },
    })

    if (revoked.count === 0) {
      throw new NotFoundException('No such device on this account')
    }

    await this.recordEvent({
      userId: params.userId,
      deviceRef: params.deviceRef,
      type: DeviceEventType.REVOKE,
      ipAddress: params.ipAddress,
      metadata: { reason: params.reason },
    })

    await this.audit.log({
      actorType: params.actor.type,
      actorId: params.actor.id ?? params.userId,
      action: 'device.revoked',
      entity: 'Device',
      entityId: params.deviceRef,
      metadata: { reason: params.reason },
      ipAddress: params.ipAddress ?? null,
    })

    this.logger.warn(`[${this.revoke.name}] Device revoked`, {
      userId: params.userId,
      deviceRef: params.deviceRef,
    })
  }

  // ── SIM swap (T1) ─────────────────────────────────────────────────────────
  /**
   * Detect a SIM swap on one device.
   *
   * Called from the bind path, from the telco webhook, and from a scheduled sweep.
   * Two independent triggers, either sufficient:
   *
   *  1. **Our anchor disagrees.** The serial presented now differs from the one
   *     stored at bind. This is the REAL control and it needs no carrier at all.
   *  2. **The carrier says the number was re-issued.** Corroboration, and the only
   *     way to catch a swap that happened while the app was closed.
   *
   * ## Fail-safe, explicitly
   *
   * When the provider cannot answer (`available: false`), an unverifiable state is
   * treated as SUSPECT if and only if our own anchor also disagrees — it does not
   * invent a swap from an outage. But it never treats "could not check" as "checked
   * and fine", which is the direction that silently switches the control off.
   */
  async detectSimSwap(params: {
    deviceRef: string
    mobileHash: string
    presentedSimSerialHash: string | null
    source: 'bind' | 'webhook' | 'sweep'
  }): Promise<{ suspected: boolean; reason?: string }> {
    const device = await this.prisma.device.findUnique({
      where: { id: params.deviceRef },
    })
    if (!device) return { suspected: false }
    if (device.status === DeviceStatus.REVOKED) return { suspected: false }

    const anchorDisagrees = Boolean(
      device.simSerialHash &&
      params.presentedSimSerialHash &&
      device.simSerialHash !== params.presentedSimSerialHash,
    )

    let carrierFlagged = false
    let carrierDetail: string | undefined

    try {
      const verification = await this.providers
        .telco()
        .verifySim(params.mobileHash, params.presentedSimSerialHash ?? '')

      if (verification.available) {
        carrierFlagged = !verification.matched
        carrierDetail = verification.detail
      } else {
        /**
         * Provider outage. Logged, and the anchor comparison still decides.
         *
         * Deliberately NOT treated as a swap: flagging every device during a carrier
         * outage would freeze the whole user base for value, which is a
         * denial-of-service we would have inflicted on ourselves.
         */
        this.logger.warn(
          `[${this.detectSimSwap.name}] Telco provider unavailable — relying on the stored anchor alone`,
          { deviceRef: params.deviceRef, detail: verification.detail },
        )
      }
    } catch (error) {
      this.logger.error(
        `[${this.detectSimSwap.name}] Telco check threw — relying on the stored anchor alone`,
        { err: error, deviceRef: params.deviceRef },
      )
    }

    if (!anchorDisagrees && !carrierFlagged) {
      /**
       * No swap. Opportunistically anchor a serial if we never had one, so a device
       * that could not report its ICCID at bind becomes swap-checkable later.
       */
      if (!device.simSerialHash && params.presentedSimSerialHash) {
        await this.prisma.device.update({
          where: { id: device.id },
          data: { simSerialHash: params.presentedSimSerialHash },
        })
      }
      return { suspected: false }
    }

    if (!canDeviceTransition(device.status, DeviceStatus.SUSPECTED_SWAP)) {
      // Already SUSPECTED_SWAP, or revoked. Nothing to change.
      return { suspected: device.status === DeviceStatus.SUSPECTED_SWAP }
    }

    const reason = anchorDisagrees
      ? 'The SIM in this device is not the one it was registered with'
      : `The carrier reported this number was re-issued${carrierDetail ? ` (${carrierDetail})` : ''}`

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        status: DeviceStatus.SUSPECTED_SWAP,
        swapDetectedAt: new Date(),
        /**
         * A fresh cooling-off window, so a swapped device cannot move value even if
         * its original one had already elapsed. This is the control that turns a
         * successful SIM swap from "attacker now receives OTPs" into "attacker
         * receives OTPs and still cannot send money".
         */
        coolingOffUntil: new Date(Date.now() + DEVICE_COOLING_OFF_MS),
      },
    })

    await this.recordEvent({
      userId: device.userId,
      deviceRef: device.id,
      type: DeviceEventType.SUSPECTED_SWAP,
      simSerialHash: params.presentedSimSerialHash,
      metadata: { source: params.source, anchorDisagrees, carrierFlagged },
    })

    await this.audit.log({
      actorType: ActorType.SYSTEM,
      action: 'device.sim_swap_suspected',
      entity: 'Device',
      entityId: device.id,
      metadata: { source: params.source, anchorDisagrees, carrierFlagged },
    })

    this.logger.warn(
      `[${this.detectSimSwap.name}] Device moved to SUSPECTED_SWAP`,
      {
        deviceRef: device.id,
        userId: device.userId,
        source: params.source,
        anchorDisagrees,
        carrierFlagged,
      },
    )

    return { suspected: true, reason }
  }

  /**
   * Every device bound to a mobile number, for a telco callback.
   *
   * A webhook names a NUMBER, not a device — the carrier has no idea which handsets
   * we bound. So a SIM change fans out across every device on that account, because
   * the swap invalidates all of them equally.
   *
   * ## Why this takes a plaintext number rather than a hash
   *
   * The obvious signature is `devicesForMobileHash(hash)`, matching how M6 stores
   * every other cross-user identifier. It is the wrong choice here, and the reason is
   * a performance cliff rather than a privacy one: a hash cannot be reversed, so
   * resolving it means loading EVERY user with a phone number and hashing each one —
   * a full table scan on a webhook path, run once per SIM change.
   *
   * The privacy argument for hashing does not apply to this lookup either. Hashing
   * exists to avoid a central plaintext record of RELATIONSHIPS BETWEEN users
   * (`EntityLink`, `ListEntry`). This is a direct lookup of one user by a number we
   * already store in plaintext on `User.phone`, over an HMAC-authenticated body on a
   * TLS connection. Hashing it would buy nothing and cost a table scan.
   */
  async devicesForMobile(phone: string): Promise<Device[]> {
    const normalised = normalisePhone(phone)
    if (!normalised) return []

    // `User.phone` is UNIQUE, so this is one indexed read.
    const user = await this.prisma.user.findUnique({
      where: { phone: normalised },
      select: { id: true },
    })
    if (!user) return []

    return this.prisma.device.findMany({
      where: {
        userId: user.id,
        status: { in: [DeviceStatus.ACTIVE, DeviceStatus.BINDING] },
      },
    })
  }

  /** The hash a telco callback's number maps to, for the provider check. */
  mobileHashFor(phone: string): string {
    return hashMobile(phone)
  }

  /**
   * Return a device to `ACTIVE` after a legitimate SIM change.
   *
   * Called only by `StepUpService` on a passed `DEVICE_RECOVERY` challenge. It
   * RE-ANCHORS the serial, which is what makes recovery meaningful: a legitimate
   * user's new SIM becomes the new baseline, while an attacker who cannot pass the
   * challenge leaves the device frozen. The cooling-off window is deliberately NOT
   * cleared — a recovered device is still a recently-changed one.
   */
  async recover(
    deviceRef: string,
    newSimSerialHash: string | null,
  ): Promise<Device> {
    const device = await this.load(deviceRef)

    if (!canDeviceTransition(device.status, DeviceStatus.ACTIVE)) {
      throw new ConflictException(
        `A ${device.status.toLowerCase()} device cannot be recovered`,
      )
    }

    const updated = await this.prisma.device.update({
      where: { id: deviceRef },
      data: {
        status: DeviceStatus.ACTIVE,
        simSerialHash: newSimSerialHash ?? device.simSerialHash,
        swapDetectedAt: null,
        coolingOffUntil: new Date(Date.now() + DEVICE_COOLING_OFF_MS),
      },
    })

    await this.recordEvent({
      userId: device.userId,
      deviceRef,
      type: DeviceEventType.RECOVERED,
      simSerialHash: newSimSerialHash,
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: device.userId,
      action: 'device.recovered',
      entity: 'Device',
      entityId: deviceRef,
      metadata: { reAnchored: Boolean(newSimSerialHash) },
    })

    return updated
  }

  // ── events ────────────────────────────────────────────────────────────────
  /**
   * Append a device event.
   *
   * Best-effort like the audit log: a lost event must not break the action it
   * describes. Logged at `warn` rather than swallowed, because these rows are what
   * geo-velocity and the analyst's timeline are computed from.
   */
  async recordEvent(params: {
    userId: string
    deviceRef?: string | null
    type: DeviceEventType
    simSerialHash?: string | null
    integrity?: string | null
    ipAddress?: string | null
    geoHint?: string | null
    metadata?: Record<string, unknown>
  }): Promise<void> {
    try {
      await this.prisma.deviceEvent.create({
        data: {
          userId: params.userId,
          deviceRef: params.deviceRef ?? null,
          type: params.type,
          simSerialHash: params.simSerialHash ?? null,
          integrity: params.integrity ?? null,
          ipHash: params.ipAddress ? hashIpNetwork(params.ipAddress) : null,
          geoHint: params.geoHint ?? null,
          /**
           * Cast rather than round-tripped through `JSON.parse(JSON.stringify(...))`.
           *
           * The round-trip returns `any`, which defeats the point of the column's typing
           * and trips `no-unsafe-assignment`. Every caller in this module passes a flat
           * record of primitives, so the cast is honest — and `Prisma.InputJsonValue` is
           * exactly the contract the column accepts.
           */
          metadata: params.metadata
            ? (params.metadata as Prisma.InputJsonValue)
            : undefined,
        },
      })
    } catch (error) {
      this.logger.warn(
        `[${this.recordEvent.name}] Failed to record a device event`,
        { err: error, type: params.type },
      )
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private async load(deviceRef: string): Promise<Device> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceRef },
    })
    if (!device) throw new NotFoundException('No such device')
    return device
  }

  /**
   * Refuse a bind that would exceed the per-account device cap.
   *
   * "One attacker operating twelve handsets on one account" and "a person with a
   * phone, a tablet and a spare" are indistinguishable until you count. Forcing an
   * explicit revoke means the user SEES the eviction rather than having the platform
   * silently drop a device they still use.
   */
  private async assertDeviceSlotAvailable(
    userId: string,
    excludeDeviceRef?: string,
  ): Promise<void> {
    const active = await this.prisma.device.count({
      where: {
        userId,
        status: { in: [DeviceStatus.ACTIVE, DeviceStatus.SUSPECTED_SWAP] },
        ...(excludeDeviceRef ? { id: { not: excludeDeviceRef } } : {}),
      },
    })

    if (active >= MAX_ACTIVE_DEVICES) {
      throw new BadRequestException(
        `You have ${active} registered devices, which is the maximum. Remove one before adding another.`,
      )
    }
  }

  /**
   * Update `lastSeenAt`, fire-and-forget.
   *
   * Not awaited by `signals`, because a timestamp touch must never add latency to
   * the payment path, and a failure to record one is not worth failing a transfer
   * over. The `catch` is required: an unhandled rejection from a floating promise
   * would take the process down under Node's default policy.
   */
  private touch(deviceRef: string): Promise<unknown> {
    return this.prisma.device
      .update({
        where: { id: deviceRef },
        data: { lastSeenAt: new Date() },
      })
      .catch((error: unknown) => {
        this.logger.warn(`[${this.touch.name}] Failed to touch lastSeenAt`, {
          err: error,
          deviceRef,
        })
      })
  }
}

/**
 * Canonicalise a phone number to the E.164 form `User.phone` is stored in.
 *
 * Matches `AuthService.formatPhone`'s output (`+` followed by digits), because this
 * looks up rows that path created. A telco sending `+91 98765 43210` or
 * `919876543210` must find the same user as one sending `+919876543210`.
 */
function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits ? `+${digits}` : ''
}
