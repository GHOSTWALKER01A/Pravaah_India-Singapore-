import { z } from 'zod'

import { DeviceIntegritySchema } from '../schemas/fraud-enums.schema'

/**
 * A device's self-reported context, sent on bind and on any sensitive action.
 *
 * Every field here is a CLAIM by the client, not a fact, and the engine treats it
 * that way — the integrity verdict is scored, not trusted, and a client that lies
 * by omission gets `UNKNOWN` rather than a pass. The reason to collect it anyway
 * is that an attacker operating from an emulator farm usually cannot be bothered
 * to spoof consistently, and the inconsistency is itself the signal.
 */
export const DeviceContextSchema = z.object({
  /** The app's installation id. A uuid because that is what the client generates. */
  deviceId: z.uuid(),
  platform: z.enum(['ios', 'android', 'web']),
  /**
   * The SIM's ICCID — hashed BEFORE it is stored, and never logged.
   *
   * Optional because iOS does not expose it and a web client has no SIM at all.
   * Absent means swap detection is unavailable for this device, which is scored
   * as reduced assurance rather than treated as a pass.
   */
  simSerial: z.string().trim().min(6).max(32).optional(),
  integrity: DeviceIntegritySchema.default('UNKNOWN'),
  model: z.string().trim().max(80).optional(),
  osVersion: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
  /**
   * Coarse location — a country or country-region code, never a coordinate.
   *
   * "IN-MH" is enough to catch impossible travel; a latitude is not needed for
   * that and would make this a location-tracking table subject to a much heavier
   * consent and retention regime under DPDP.
   */
  geoHint: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}(-[A-Z0-9]{2,3})?$/, 'Expected a code like "SG" or "IN-MH"')
    .optional(),
})
export type DeviceContextDto = z.infer<typeof DeviceContextSchema>

/**
 * Begin binding a device.
 *
 * Returns a step-up challenge, never a binding token. A bind that handed back
 * credentials before the challenge was answered would make the challenge
 * decorative — which is the whole attack in an account takeover, where the
 * attacker has the password and needs only a device.
 */
export const BindDeviceSchema = DeviceContextSchema
export type BindDeviceDto = z.infer<typeof BindDeviceSchema>

/**
 * Complete a bind by answering the challenge.
 *
 * The nonce identifies the challenge; the answer proves possession. Both are
 * required, and the nonce is single-use, so a captured pair cannot bind a second
 * device.
 */
export const ConfirmBindSchema = z.object({
  nonce: z.uuid(),
  answer: z.string().trim().min(1).max(64),
})
export type ConfirmBindDto = z.infer<typeof ConfirmBindSchema>

/**
 * Report a SIM change and re-verify a device out of `SUSPECTED_SWAP`.
 *
 * The legitimate path for somebody who simply changed their SIM. It still costs a
 * step-up, because the attacker who swapped the victim's SIM would like to use
 * exactly this endpoint.
 */
export const RecoverDeviceSchema = z.object({
  nonce: z.uuid(),
  answer: z.string().trim().min(1).max(64),
  simSerial: z.string().trim().min(6).max(32).optional(),
})
export type RecoverDeviceDto = z.infer<typeof RecoverDeviceSchema>
