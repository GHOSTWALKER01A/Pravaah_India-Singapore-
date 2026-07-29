import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type {
  DeviceContext,
  DeviceIntegrity,
} from '@/api/security/schemas';

/**
 * This installation's stable identity, and what the app truthfully knows about itself.
 *
 * ## Why the id must PERSIST, and what breaks if it does not
 *
 * The device id is the anchor for every M6 device control: the cooling-off window, the SIM
 * anchor, the binding token, the shared-device graph edge. All of those are keyed on
 * `(userId, deviceId)` server-side.
 *
 * So an id regenerated per launch is not a minor bug — it silently disables the entire
 * device layer. Every launch would look like a NEW device: a fresh bind, a fresh 24-hour
 * cooling-off, and a `DEVICE_NEW` signal on every payment the user ever makes. The control
 * would fire constantly, users would be challenged forever, and an operator would
 * eventually turn the weight down to zero to stop the noise — at which point the real
 * account-takeover signal is gone too.
 *
 * That is why this uses `expo-secure-store` rather than module state, and why
 * {@link resolveDeviceId} is the only way to obtain one.
 *
 * ## Why SecureStore and not AsyncStorage
 *
 * Not primarily for secrecy — the device id is not a secret, and the server treats it as a
 * client claim regardless. It is for DURABILITY and scope: the Keychain/Keystore item
 * survives app updates, is not readable by other apps, and is not swept by the OS the way
 * a cache directory can be. An id that vanished under storage pressure would produce
 * exactly the per-launch-rebind failure above, intermittently and unreproducibly.
 *
 * ## The honest limit on integrity detection
 *
 * {@link readIntegrity} reports `EMULATOR` from `Device.isDevice` and otherwise `OK`. It
 * does NOT detect root or jailbreak — that needs a native RASP module (Play Integrity,
 * DeviceCheck, or a commercial SDK), which is the production hardening step. Reporting
 * `OK` for a rooted handset would be a lie, so the value this returns is deliberately the
 * weakest true claim available, and the server weights it accordingly: `UNKNOWN` and `OK`
 * are scored differently precisely because a client's own verdict cannot be trusted.
 */

/**
 * Keychain/Keystore item id. Versioned, so a future migration to a
 * hardware-attested identifier can live alongside this one rather than silently
 * reinterpreting its bytes — the same reasoning `holder-key.ts` applies.
 */
const DEVICE_ID_ITEM = 'pravaah.security.deviceId.v1';

/** Memoised for the process, so repeated calls in one session skip the keystore. */
let cachedDeviceId: string | null = null;

/**
 * The persisted installation id, minting one on first call.
 *
 * ## Why a failed keystore still returns an id
 *
 * On a device where SecureStore is unavailable — a missing native module in Expo Go, a
 * locked keystore, a web build — this falls back to a process-lifetime id rather than
 * throwing. That is the right trade: the alternative is an app that cannot send money
 * because it could not write a device identifier.
 *
 * The consequence is honest and bounded: that session behaves as an unrecognised device
 * and gets challenged. It does NOT get waved through. Failing OPEN here would mean a
 * device-layer bypass available to anyone who could break SecureStore; failing to a
 * challenge means the layer degrades to "prove it another way", which is what the whole
 * module is built to do.
 */
export async function resolveDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    const stored = await SecureStore.getItemAsync(DEVICE_ID_ITEM);
    if (stored && isUuid(stored)) {
      cachedDeviceId = stored;
      return stored;
    }

    /**
     * `randomUUID` from `expo-crypto`, not a hand-rolled string.
     *
     * The server's DTO validates `z.uuid()`, so a non-uuid id is a 400 on every bind. It
     * is also stored in a `@db.Uuid` column, which would reject anything else with a
     * Postgres `22P02` — the failure mode is a hard error on a path the user cannot
     * retry out of, not a graceful degradation.
     */
    const minted = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_ITEM, minted);
    cachedDeviceId = minted;
    return minted;
  } catch {
    /**
     * Keystore unavailable. Mint a process-lifetime id and DO NOT cache it to storage.
     *
     * Not cached to `cachedDeviceId` either, deliberately: a retry later in the session
     * may find the keystore working (a locked device that has since been unlocked), and
     * pinning the ephemeral id would prevent the app from ever settling on a stable one.
     */
    return Crypto.randomUUID();
  }
}

/**
 * How long a "Not now" on the bind prompt is respected.
 *
 * ## Why a snooze exists at all
 *
 * Without one, dismissing the prompt is meaningless: the device stays in `BINDING`, so the
 * next launch issues a fresh challenge and the sheet returns — every single time, forever.
 * A prompt that reappears no matter what the user does is not a choice, and it trains people
 * to close the app rather than read it.
 *
 * Seven days rather than permanently, because the device genuinely SHOULD be bound: an
 * unbound device is challenged on every large payment, which is worse for the user than one
 * code now. So the answer is respected, then asked again — not respected forever.
 */
const BIND_SNOOZE_ITEM = 'pravaah.security.bindSnoozedUntil.v1'
const BIND_SNOOZE_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * Record that the user declined to bind, and stop asking for a while.
 *
 * Failures are swallowed. If the snooze cannot be written the prompt simply returns next
 * launch, which is the pre-existing behaviour and not worth surfacing an error for.
 */
export async function snoozeDeviceBind(): Promise<void> {
  try {
    await SecureStore.setItemAsync(
      BIND_SNOOZE_ITEM,
      String(Date.now() + BIND_SNOOZE_MS),
    )
  } catch {
    // Nothing to do — the prompt reappears next launch, as it did before.
  }
}

/**
 * Whether the bind prompt is currently snoozed.
 *
 * Returns FALSE on any read failure or malformed value, so the failure mode is "ask" rather
 * than "stay silent". A corrupted snooze that silently suppressed the prompt forever would
 * leave a device permanently unbound with no way for the user to discover why their payments
 * keep asking for a code.
 */
export async function isDeviceBindSnoozed(): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(BIND_SNOOZE_ITEM)
    if (!stored) return false
    const until = Number(stored)
    return Number.isFinite(until) && until > Date.now()
  } catch {
    return false
  }
}

/** Clear the snooze, so the prompt can appear again. Used when a bind succeeds. */
export async function clearDeviceBindSnooze(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(BIND_SNOOZE_ITEM)
  } catch {
    // Already unreadable, which is the state we wanted.
  }
}

/**
 * Forget the persisted id.
 *
 * Called on logout ONLY if the user asks to forget the device — not on an ordinary sign
 * out. An id cleared on every logout would defeat its purpose: the next sign-in would
 * rebind and restart the cooling-off, so a user who signs out nightly would face a
 * challenge on every large payment forever.
 */
export async function forgetDeviceId(): Promise<void> {
  cachedDeviceId = null;
  try {
    await SecureStore.deleteItemAsync(DEVICE_ID_ITEM);
  } catch {
    // Nothing to do. The id is already unreadable, which is the state we wanted.
  }
}

/**
 * What the app can truthfully say about its integrity.
 *
 * `Device.isDevice` is `false` on a simulator or emulator, which is the one integrity fact
 * available without a native RASP module. Everything else reports `OK`, and the server
 * knows that `OK` from a client is a claim rather than an attestation.
 */
export function readIntegrity(): DeviceIntegrity {
  /**
   * A web build has no device integrity to report at all. `UNKNOWN` rather than `OK`,
   * because "there is no check here" is a different fact from "the check passed" — and
   * the server scores them differently on purpose.
   */
  if (Platform.OS === 'web') return 'UNKNOWN';
  return Device.isDevice ? 'OK' : 'EMULATOR';
}

/**
 * The platform, in the vocabulary the server's DTO accepts.
 *
 * Narrowed rather than passed through: `Platform.OS` can also be `macos` or `windows`,
 * and the server enum has three members. An unmapped value would fail validation on every
 * bind from a platform we had not thought about, so anything unexpected reports as `web` —
 * the least-privileged of the three, since it is the one with no SIM and no attestation.
 */
export function readPlatform(): DeviceContext['platform'] {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/**
 * The full context to send on a bind or a sensitive action.
 *
 * ## What is deliberately NOT here: `simSerial`
 *
 * Reading the SIM's ICCID needs a native module and, on Android, the
 * `READ_PRIVILEGED_PHONE_STATE` permission — which is reserved for system apps. iOS does
 * not expose it at all. So this app cannot supply it, and the server is built for that: a
 * device with no SIM anchor emits `SIM_UNVERIFIABLE` (weight 0.15) rather than being
 * refused, and swap detection falls back to the carrier webhook.
 *
 * Sending a FABRICATED serial would be worse than sending none. It would satisfy the
 * anchor check forever — including for an attacker who had genuinely swapped the SIM —
 * which turns a working control into one that reports success while being switched off.
 * The absent field is the honest answer, and the reason the server treats absence as
 * reduced assurance rather than as a pass.
 */
export async function readDeviceContext(
  geoHint?: string,
): Promise<DeviceContext> {
  return {
    deviceId: await resolveDeviceId(),
    platform: readPlatform(),
    integrity: readIntegrity(),
    /**
     * Truncated to the server's limits rather than sent raw.
     *
     * `Device.modelName` can be a long vendor string, and a field that overruns the DTO's
     * `max()` fails the whole bind on a validation error the user cannot act on. Losing
     * the tail of a model name costs nothing; losing the bind costs the device layer.
     */
    model: Device.modelName?.slice(0, 80) ?? undefined,
    osVersion: Device.osVersion?.slice(0, 40) ?? undefined,
    appVersion: appVersion(),
    geoHint,
  };
}

/** The build's version string, for the analyst's device timeline. */
function appVersion(): string | undefined {
  const version = Constants.expoConfig?.version;
  return typeof version === 'string' ? version.slice(0, 40) : undefined;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard the stored value before trusting it.
 *
 * A keystore item written by an older build — or corrupted — would otherwise be sent as a
 * device id and 400 on every bind, with no way for the user to recover short of
 * reinstalling. Validating on read means a bad value is silently replaced by a good one.
 */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
