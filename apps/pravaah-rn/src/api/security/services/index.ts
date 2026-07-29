/**
 * M6 security API.
 *
 * Two services rather than one, because they have genuinely different lifetimes: the
 * device service runs on every launch (bind-on-boot), while the security service is
 * touched only when a challenge is outstanding or the user opens the activity screen.
 * Splitting them keeps the boot path from importing the transparency views it never uses.
 *
 * Nothing here takes an idempotency key. None of these calls move money, and the two that
 * matter are protected by stronger guarantees than a client-held key: `begin` is
 * server-side idempotent on `(userId, deviceId)`, and every challenge is single-use by
 * nonce — a replay is REFUSED rather than answered with the first call's success.
 */

export { deviceService } from './device.service';
export { pinService } from './pin.service';
export { securityService } from './security.service';
