import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import {
  SECRET_BYTES,
  buildKeyBindingJwt,
  isValidSecret,
  bytesToHex,
  hexToBytes,
  publicJwkFromSecret,
  type HolderPublicJwk,
  type KeyBindingInput,
} from './holder-crypto';

export type { HolderPublicJwk, KeyBindingInput };

/**
 * The holder key's STORAGE and LIFETIME — the most security-critical file in the app.
 *
 * A Pravaah passport is bound to THIS device by a P-256 key pinned in the credential's `cnf`
 * claim. Every presentation carries a Key Binding JWT signed by that key, so possession of
 * the credential is not the ability to present it: a credential lifted from a phone backup,
 * or from Pravaah's own database, is inert without this key.
 *
 * Two rules, and everything here follows from them:
 *
 *   1. THE PRIVATE KEY NEVER LEAVES THIS MODULE. Only the public half is sent to the server,
 *      at issuance. Nothing exports it, nothing logs it, and no other module can read it —
 *      {@link publicJwk} and {@link signKeyBinding} are the whole surface.
 *   2. LOSING IT IS RECOVERABLE, BY RE-ISSUING. There is no backup and no escrow, because an
 *      escrowed holder key would let whoever holds the escrow present the user's reputation.
 *      A wiped device re-issues against a fresh key; the old credential is superseded and
 *      revoked server-side.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE, stated plainly because the difference matters.
 * `expo-secure-store` puts the key in the iOS Keychain / Android Keystore-backed store, so it
 * is encrypted at rest by the OS and unreadable by other apps. It is NOT a non-exportable
 * hardware key: this process can read the scalar in order to sign, and signing happens in
 * JavaScript. A truly non-exportable key (`SecKeyCreateRandomKey` with a Secure Enclave
 * access control, or an Android StrongBox key) needs a native module and is the production
 * hardening step. The threat this DOES defeat is the one the credential design cares about
 * most: an attacker holding the credential bytes but not this device.
 *
 * The cryptography itself lives in `holder-crypto.ts`, which imports no Expo modules so it
 * can be — and is — verified against `node:crypto` by `scripts/verify-holder-key.ts`.
 */

/**
 * Keychain/Keystore item ids. Versioned so a future migration to a hardware-backed key can
 * live alongside this one rather than silently reinterpreting its bytes.
 */
const KEY_ITEM = 'pravaah.passport.holder.v1';
const META_ITEM = 'pravaah.passport.holder.meta.v1';

/** Attempts before giving up on the platform CSPRNG producing an in-range scalar. */
const KEYGEN_ATTEMPTS = 4;

interface HolderMeta {
  createdAt: string;
  credentialId?: string;
  credentialNumber?: string;
}

/** Why the device key could not be read, created, or used. */
export type HolderKeyFailure =
  /** The app binary has no `ExpoSecureStore` / `ExpoCrypto`. Needs a rebuild, not a retry. */
  | 'NATIVE_MODULE_MISSING'
  /** The keystore exists but refused — locked device, or an OS-level denial. */
  | 'KEYSTORE_UNAVAILABLE'
  /** Entropy was available but never produced an in-range scalar. */
  | 'GENERATION_FAILED'
  /** No key on this device: a reinstall, or a wipe after revocation. */
  | 'NO_KEY';

/**
 * A holder-key failure with its cause classified.
 *
 * Typed rather than a bare `Error` because the four reasons need four different responses
 * from the user, and collapsing them into one message is what made this undiagnosable: a
 * missing native module needs a new build, a locked keystore needs the phone unlocked, and
 * a missing key needs a re-issue. "Could not issue your passport" tells the user none of
 * that, and tells a developer nothing at all.
 */
export class HolderKeyError extends Error {
  constructor(
    readonly reason: HolderKeyFailure,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HolderKeyError';
  }
}

/**
 * Recognise "this build has no native module for that".
 *
 * Expo signals it two ways and both must be caught: `requireNativeModule` throws a plain
 * `Error("Cannot find native module 'ExpoSecureStore'")` when the module is absent from the
 * binary, and `UnavailabilityError` carries `code: 'ERR_UNAVAILABLE'` when the module loaded
 * but the platform lacks the method.
 *
 * This is the error a freshly-added native dependency produces on a dev client built BEFORE
 * it was added — no amount of retrying fixes it, so it must not be reported as a transient
 * failure.
 */
function isNativeModuleMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ERR_UNAVAILABLE') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /cannot find native module/i.test(message) ||
    /is not available on/i.test(message)
  );
}

/**
 * Wrap a native call so its failure arrives classified.
 *
 * `what` names the operation for the log line, because the user-facing message deliberately
 * says nothing about keystores — but a developer staring at Metro output needs to know
 * whether it was the read, the write, or the entropy that failed.
 */
async function nativeCall<T>(what: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isNativeModuleMissing(error)) {
      console.warn(
        `[holder-key] ${what} failed: this build has no secure-storage native module. ` +
          'expo-secure-store and expo-crypto were added to package.json, so a dev client ' +
          'built before that needs rebuilding — `npx expo run:android` (or a new EAS ' +
          'development build). Reloading JS is not enough.',
        error,
      );
      throw new HolderKeyError(
        'NATIVE_MODULE_MISSING',
        'This version of the app cannot store your passport key securely. Update to the latest build and try again.',
        error,
      );
    }
    console.warn(`[holder-key] ${what} failed`, error);
    throw new HolderKeyError(
      'KEYSTORE_UNAVAILABLE',
      'Your phone’s secure storage is not available right now. Unlock your device and try again.',
      error,
    );
  }
}

/**
 * Options every write uses.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` survives a backup/restore onto the SAME device but is
 * never included in an iCloud or iTunes backup — so restoring onto a NEW device does not
 * carry the key across. That is correct rather than merely conservative: a new device must
 * re-issue, and a key that travelled would mean two devices able to present one credential.
 */
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Read the stored secret, or null when this device has no key yet.
 *
 * Deliberately private and never memoised. Holding the scalar in a module-level variable
 * would keep it in the JS heap for the life of the process, where a heap snapshot or a crash
 * report could carry it. Reading per signature keeps its lifetime to one call.
 */
async function readSecret(): Promise<Uint8Array | null> {
  const stored = await nativeCall('reading the device key', () =>
    SecureStore.getItemAsync(KEY_ITEM, STORE_OPTIONS),
  );
  if (!stored) return null;
  // A stored value of the wrong length is corruption, not a key. Treated as absent so the
  // caller re-generates rather than passing garbage to the curve maths.
  if (!/^[0-9a-f]+$/i.test(stored) || stored.length !== SECRET_BYTES * 2) {
    return null;
  }
  const secret = hexToBytes(stored);
  return isValidSecret(secret) ? secret : null;
}

/**
 * Generate the device key.
 *
 * Entropy comes from `expo-crypto` — the platform CSPRNG (`SecRandomCopyBytes` /
 * `SecureRandom`) — rather than noble's own `randomSecretKey()`. That helper needs a global
 * `crypto.getRandomValues`, which React Native does not provide by default, so relying on it
 * would work under a polyfill and silently fail without one. Supplying our own bytes makes
 * the source explicit and that failure impossible.
 *
 * The retry loop covers a scalar landing outside [1, n-1], probability around 2^-128. It
 * runs once in practice; the alternative to retrying is generating an invalid key and
 * discovering it at the first signature, in front of a verifier.
 */
async function generate(): Promise<Uint8Array> {
  let lastError: unknown;

  for (let attempt = 0; attempt < KEYGEN_ATTEMPTS; attempt += 1) {
    const candidate = await nativeCall('generating entropy', () =>
      Crypto.getRandomBytes(SECRET_BYTES),
    );
    if (candidate.length !== SECRET_BYTES) {
      lastError = new Error(
        `entropy source returned ${candidate.length} bytes, expected ${SECRET_BYTES}`,
      );
      continue;
    }
    try {
      // Deriving the public key is the real validation: it rejects an out-of-range scalar
      // AND surfaces a broken curve implementation. Called directly rather than through
      // `isValidSecret`, whose `catch {}` discards the very error we need.
      publicJwkFromSecret(candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  /**
   * Four failures in a row is NOT bad luck.
   *
   * An out-of-range scalar has probability ~2^-128, so four consecutively is not chance —
   * it means the curve library itself cannot run here. That distinction matters enormously:
   * "try again" is useless advice for a broken library, and this exact failure was caused by
   * Metro resolving a mismatched `@noble/hashes` (see `scripts/verify-holder-key.ts` §0).
   *
   * The cause is logged, and attached to the error, because a bare "could not create a key"
   * is what made this take three rounds to diagnose.
   */
  console.warn(
    '[holder-key] key generation failed on every attempt. Entropy is fine (it was ' +
      'produced), so this is the P-256 implementation failing in this runtime — most ' +
      'likely a dependency-resolution mismatch rather than a device problem. ' +
      'Run `npm run verify:holder-key` and check §0. Underlying error:',
    lastError,
  );
  throw new HolderKeyError(
    'GENERATION_FAILED',
    'This build cannot create a secure key. This is an app defect, not a problem with your phone — please report it.',
    lastError,
  );
}

/**
 * Ensure this device has a holder key, and return its PUBLIC half.
 *
 * Idempotent: an existing key is reused, so calling this twice cannot orphan a credential
 * that was already issued against the first one.
 */
export async function ensureHolderKey(): Promise<HolderPublicJwk> {
  const existing = await readSecret();
  if (existing) return publicJwkFromSecret(existing);

  const secret = await generate();
  await nativeCall('storing the device key', () =>
    SecureStore.setItemAsync(KEY_ITEM, bytesToHex(secret), STORE_OPTIONS),
  );
  await nativeCall('storing key metadata', () =>
    SecureStore.setItemAsync(
      META_ITEM,
      JSON.stringify({ createdAt: new Date().toISOString() } satisfies HolderMeta),
      STORE_OPTIONS,
    ),
  );
  return publicJwkFromSecret(secret);
}

/**
 * True when this device already holds a usable key.
 *
 * Swallows a failure into `false` because the wallet calls this on every refetch: a broken
 * build would otherwise blank the whole screen on a read, hiding the credential AND the
 * message explaining why. Issuance still reports the real reason, which is where the user
 * can act on it.
 */
export async function hasHolderKey(): Promise<boolean> {
  try {
    return (await readSecret()) !== null;
  } catch {
    return false;
  }
}

/** The public key to send at issuance. Generates one on first call. */
export async function publicJwk(): Promise<HolderPublicJwk> {
  return ensureHolderKey();
}

/**
 * Sign a Key Binding JWT with this device's key.
 *
 * The error message matters: a missing key is not a transient failure the user can retry
 * their way out of, it means this device cannot present the credential at all and must
 * re-issue. Saying so is the difference between a dead end and one tap.
 */
export async function signKeyBinding(
  input: KeyBindingInput,
): Promise<string> {
  const secret = await readSecret();
  if (!secret) {
    throw new HolderKeyError(
      'NO_KEY',
      'This device has no passport key. Issue your passport again to create one.',
    );
  }
  return buildKeyBindingJwt(secret, input);
}

/** Note which credential this key now carries, for mismatch diagnostics. */
export async function rememberCredential(
  credentialId: string,
  credentialNumber: string,
): Promise<void> {
  const existing = await nativeCall('reading key metadata', () =>
    SecureStore.getItemAsync(META_ITEM, STORE_OPTIONS),
  );
  let meta: HolderMeta = { createdAt: new Date().toISOString() };
  if (existing) {
    // Corrupt metadata must not break issuance — it is diagnostics, not key material.
    try {
      meta = JSON.parse(existing) as HolderMeta;
    } catch {
      /* fall through to a fresh record */
    }
  }
  await nativeCall('updating key metadata', () =>
    SecureStore.setItemAsync(
      META_ITEM,
      JSON.stringify({ ...meta, credentialId, credentialNumber }),
      STORE_OPTIONS,
    ),
  );
}

export async function holderMeta(): Promise<HolderMeta | null> {
  const stored = await SecureStore.getItemAsync(META_ITEM, STORE_OPTIONS);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as HolderMeta;
  } catch {
    return null;
  }
}

/**
 * Destroy the device key.
 *
 * Called on sign-out and after the holder revokes their passport. Irreversible by design: the
 * key IS the binding, so keeping it after a revocation would preserve the ability to present
 * a credential the user has already disowned. The next issuance mints a fresh key and the
 * server supersedes the old credential.
 */
export async function forgetHolderKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_ITEM, STORE_OPTIONS);
  await SecureStore.deleteItemAsync(META_ITEM, STORE_OPTIONS);
}
