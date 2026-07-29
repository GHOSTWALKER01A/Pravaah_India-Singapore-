import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * What the handset can prove about the person holding it, and how to ask.
 *
 * ## The one distinction the rest of this feature depends on
 *
 * There are TWO different things called "biometric authentication" in this app, and conflating
 * them would produce a security hole that looks like working code:
 *
 *  1. **Keystore-gated storage** — a value written with `requireAuthentication: true` is
 *     encrypted under a key the OS will not release until it has authenticated the user. The
 *     gate is enforced by the secure hardware; the app cannot read the value and then decide
 *     whether it should have. That is how the persisted session is held — see
 *     `session-vault.ts`.
 *
 *  2. **A local yes/no** — {@link authenticateLocally} asks the OS "is this the owner?" and
 *     gets a boolean. Nothing is encrypted, so the answer is only as trustworthy as the
 *     process asking. A repackaged app, or a rooted device, can lie.
 *
 * Anything protecting a SECRET must use (1). (2) is for authorising an action where there is no
 * secret to gate — a PIN change, where the thing being protected lives on the server. Using (2)
 * where (1) belongs is the classic mistake: "authenticate, then read the plainly-stored token"
 * is bypassed by reading the token.
 *
 * ## Why the level matters and is not merely informational
 *
 * `SecurityLevel` distinguishes a fingerprint or 3D face scan (`BIOMETRIC_STRONG`) from a
 * pattern or PIN (`SECRET`) from a 2D face unlock that a photograph can defeat
 * (`BIOMETRIC_WEAK`). Treating those as one thing means "biometric protected" describes an
 * account whose second factor is a four-dot swipe pattern. Every call site here states which
 * level it will accept, and the PIN change accepts only the strongest.
 */

/** The strength of what the device has enrolled. Mirrors the server's `BiometricLevelInput`. */
export type BiometricLevel =
  | 'NONE'
  | 'SECRET'
  | 'BIOMETRIC_WEAK'
  | 'BIOMETRIC_STRONG';

/** Which sensor, so the prompt can say "fingerprint" or "Face ID" rather than "biometrics". */
export type BiometricKind = 'FINGERPRINT' | 'FACE' | 'IRIS';

export interface BiometricCapability {
  /** A sensor exists. False on most emulators and on any handset without one. */
  hardware: boolean;
  /** Something is enrolled that the OS will actually authenticate against. */
  enrolled: boolean;
  /** The strongest enrolled factor. `NONE` means there is no lock screen at all. */
  level: BiometricLevel;
  /** The sensors present, for prompt copy. Empty when `hardware` is false. */
  kinds: BiometricKind[];
  /**
   * Whether a secret can be written behind keystore-enforced authentication.
   *
   * Read from `SecureStore.canUseBiometricAuthentication()` rather than inferred from
   * `enrolled`, because the two can disagree: a device with a passcode but no biometric
   * hardware can still gate keystore access on the passcode, and inferring from `enrolled`
   * would refuse to persist a session on a phone that is perfectly capable of holding one.
   */
  canGateStorage: boolean;
  /**
   * Whether a real biometric — not a passcode — is available.
   *
   * The gate for anything that must NOT be satisfiable by the device unlock code. See
   * {@link authenticateLocally} on why the PIN change is one of those.
   */
  canUseBiometric: boolean;
}

/** Why a local authentication did not succeed. Distinguished because each needs a different UI. */
export type LocalAuthFailure =
  /** The user dismissed the sheet. Not an error — show nothing and leave them where they were. */
  | 'CANCELLED'
  /** The user asked for the passcode instead, and we had disabled that route. */
  | 'FALLBACK_REQUESTED'
  /** Too many wrong attempts; the OS has locked the sensor. Only another factor gets in now. */
  | 'LOCKED_OUT'
  /** Nothing is enrolled, or the device has no passcode at all. */
  | 'NOT_ENROLLED'
  /** No hardware, or the platform refused. */
  | 'UNAVAILABLE'
  /** A genuine mismatch — wrong finger, wrong face. Retryable. */
  | 'FAILED';

export type LocalAuthOutcome =
  | { ok: true }
  | { ok: false; failure: LocalAuthFailure; message: string };

/**
 * What the device is capable of.
 *
 * Every call is wrapped: on web, in Expo Go without the native module, or on a device whose
 * keystore is in a bad state, these throw rather than returning false. An exception here would
 * crash the launch gate — the one screen that must never fail to render, because it is what
 * stands between a cold start and the user's money. So a failure to ASK reports the weakest
 * true answer: no hardware, nothing enrolled, nothing gateable. The app then behaves exactly as
 * it does on a handset with no lock screen, which is a path that already has to work.
 */
export async function readBiometricCapability(): Promise<BiometricCapability> {
  const [hardware, enrolled, rawLevel, rawKinds] = await Promise.all([
    LocalAuthentication.hasHardwareAsync().catch(() => false),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
    LocalAuthentication.getEnrolledLevelAsync().catch(
      () => LocalAuthentication.SecurityLevel.NONE,
    ),
    LocalAuthentication.supportedAuthenticationTypesAsync().catch(
      () => [] as LocalAuthentication.AuthenticationType[],
    ),
  ]);

  /**
   * `canUseBiometricAuthentication` is SYNCHRONOUS and can throw, so it needs its own
   * try/catch rather than a place in the `Promise.all` above.
   */
  let canGateStorage = false;
  try {
    canGateStorage = SecureStore.canUseBiometricAuthentication();
  } catch {
    canGateStorage = false;
  }

  const level = toLevel(rawLevel);

  return {
    hardware,
    enrolled,
    level,
    kinds: hardware ? rawKinds.map(toKind).filter(isKind) : [],
    canGateStorage,
    /**
     * A real biometric means hardware AND an enrolment AND a level at or above weak.
     *
     * All three, because they fail independently: a phone can have a fingerprint reader with
     * nothing enrolled on it (`hardware` true, `enrolled` false), and a phone with only a
     * passcode reports `enrolled` true at level `SECRET` — which is an enrolment, just not of
     * a biometric. Checking any one of the three alone gets a different device class wrong.
     */
    canUseBiometric:
      hardware &&
      enrolled &&
      (level === 'BIOMETRIC_WEAK' || level === 'BIOMETRIC_STRONG'),
  };
}

/**
 * Ask the OS to authenticate the person holding the device.
 *
 * ## `allowDeviceCredential`, and why the PIN change sets it false
 *
 * With it true (the default), a user who fails the fingerprint can fall through to the device
 * unlock code and still succeed. For unlocking the app that is right — it is the same standard
 * as opening the phone, and refusing would lock out anyone with a bandaged thumb.
 *
 * For a PIN CHANGE it is wrong, and this is the single most important line in the file. The
 * dominant real-world threat to a payment PIN is somebody holding the unlocked handset who
 * watched the owner type the unlock code — a partner, a pickpocket who shoulder-surfed, a
 * colleague. If the device passcode could authorise a PIN change, that person changes the PIN
 * to one they know and the PIN has protected nothing: the factor collapses back into "can you
 * unlock this phone", which possession already answered. Requiring a fingerprint or face means
 * the change needs something the shoulder-surfer cannot have watched.
 *
 * The cost is a user with no biometric enrolled cannot change their PIN this way at all. That
 * is why the SMS-plus-cooling-off reset exists as the other route, and why it is a RESET rather
 * than a change: it is deliberately slower and more visible.
 *
 * ## `requireStrong`
 *
 * Android's default accepts `BIOMETRIC_WEAK`, which includes 2D face unlock that a printed
 * photo defeats. Anything authorising a change to a payment factor passes `requireStrong`.
 */
export async function authenticateLocally(params: {
  /** Shown in the OS sheet. Say what is being authorised, not "authenticate". */
  reason: string;
  /** Default true. False forbids the device unlock code — see above. */
  allowDeviceCredential?: boolean;
  /** Default false. True refuses `BIOMETRIC_WEAK` sensors on Android. */
  requireStrong?: boolean;
  /** Label for the dismiss control. Defaults to a plain cancel. */
  cancelLabel?: string;
}): Promise<LocalAuthOutcome> {
  const allowDeviceCredential = params.allowDeviceCredential ?? true;

  let result: LocalAuthentication.LocalAuthenticationResult;
  try {
    result = await LocalAuthentication.authenticateAsync({
      promptMessage: params.reason,
      cancelLabel: params.cancelLabel,
      disableDeviceFallback: !allowDeviceCredential,
      /**
       * iOS shows a fallback button whose label this sets, and an EMPTY STRING removes the
       * button entirely. That is the documented way to suppress the passcode route on iOS —
       * `disableDeviceFallback` alone changes the policy but can still leave the control
       * visible, and a button that appears and then does nothing reads as a broken app.
       */
      fallbackLabel: allowDeviceCredential ? undefined : '',
      biometricsSecurityLevel: params.requireStrong ? 'strong' : 'weak',
      /**
       * Android only. `false` dismisses the sheet the instant the sensor matches, with no
       * extra tap. Left at the platform default (`true`) for face unlock, where a
       * confirmation step is what stops a glance at a locked phone authorising a payment.
       */
      requireConfirmation: undefined,
    });
  } catch {
    /**
     * The native module rejected outright — absent, or the platform is web.
     *
     * `UNAVAILABLE` rather than `FAILED`, because the two mean opposite things to the caller:
     * `FAILED` invites a retry, and retrying a missing module loops forever.
     */
    return {
      ok: false,
      failure: 'UNAVAILABLE',
      message: 'This device cannot verify your identity locally.',
    };
  }

  if (result.success) return { ok: true };

  return mapFailure(result.error, allowDeviceCredential);
}

/**
 * The error strings `expo-local-authentication` returns, in the categories the UI needs.
 *
 * Exhaustive on purpose, and the `default` is the reason: an unrecognised code becomes `FAILED`
 * — retryable, no access granted. Defaulting the other way, or throwing, would turn an unknown
 * platform error into either a bypass or a crash on the launch screen.
 */
function mapFailure(
  error: string | undefined,
  allowDeviceCredential: boolean,
): { ok: false; failure: LocalAuthFailure; message: string } {
  switch (error) {
    case 'user_cancel':
    case 'app_cancel':
    case 'system_cancel':
      return {
        ok: false,
        failure: 'CANCELLED',
        message: 'Verification cancelled.',
      };

    case 'user_fallback':
      /**
       * The user chose "Enter Passcode" on a prompt where we had disabled that route.
       *
       * Distinguished from `CANCELLED` because it is a REQUEST, not a dismissal: they want the
       * other route, and the caller can offer the one we do allow — the SMS reset, for a PIN
       * change. Reporting a cancel would leave them tapping a button that appears to do
       * nothing.
       */
      return {
        ok: false,
        failure: allowDeviceCredential ? 'CANCELLED' : 'FALLBACK_REQUESTED',
        message: 'A fingerprint or face check is needed for this.',
      };

    case 'lockout':
    case 'no_space':
      /**
       * `lockout` — too many misses; the sensor is disabled until another factor unlocks the
       * device. `no_space` is Android's variant of the same state on some OEM builds.
       *
       * Both are terminal for THIS attempt, so the UI must offer a different factor rather
       * than a retry button that cannot succeed.
       */
      return {
        ok: false,
        failure: 'LOCKED_OUT',
        message:
          'Too many attempts — your device has locked biometric unlock. Unlock your phone and try again, or use another way to verify.',
      };

    case 'not_enrolled':
    case 'passcode_not_set':
      return {
        ok: false,
        failure: 'NOT_ENROLLED',
        message:
          Platform.OS === 'ios'
            ? 'Set up Face ID, Touch ID or a passcode in Settings to use this.'
            : 'Set up a fingerprint, face unlock or screen lock in Settings to use this.',
      };

    case 'not_available':
    case 'invalid_context':
      return {
        ok: false,
        failure: 'UNAVAILABLE',
        message: 'This device cannot verify your identity locally.',
      };

    case 'authentication_failed':
    case 'timeout':
    case 'unable_to_process':
    default:
      return {
        ok: false,
        failure: 'FAILED',
        message: 'That did not match. Please try again.',
      };
  }
}

function toLevel(level: LocalAuthentication.SecurityLevel): BiometricLevel {
  switch (level) {
    case LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG:
      return 'BIOMETRIC_STRONG';
    case LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK:
      return 'BIOMETRIC_WEAK';
    case LocalAuthentication.SecurityLevel.SECRET:
      return 'SECRET';
    default:
      return 'NONE';
  }
}

function toKind(
  type: LocalAuthentication.AuthenticationType,
): BiometricKind | null {
  switch (type) {
    case LocalAuthentication.AuthenticationType.FINGERPRINT:
      return 'FINGERPRINT';
    case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
      return 'FACE';
    case LocalAuthentication.AuthenticationType.IRIS:
      return 'IRIS';
    default:
      return null;
  }
}

function isKind(kind: BiometricKind | null): kind is BiometricKind {
  return kind !== null;
}

/**
 * "Fingerprint", "Face ID", or a neutral phrase — for prompts and buttons.
 *
 * iOS names its sensors and users know them by those names, so a prompt reading "use
 * biometrics" on an iPhone reads as an app that does not know what phone it is on. Android has
 * no equivalent brand, so the generic term is the honest one there.
 */
export function biometricLabel(capability: BiometricCapability): string {
  if (!capability.canUseBiometric) return 'Device unlock';

  const hasFace = capability.kinds.includes('FACE');
  const hasPrint = capability.kinds.includes('FINGERPRINT');

  if (Platform.OS === 'ios') {
    if (hasFace) return 'Face ID';
    if (hasPrint) return 'Touch ID';
    return 'Biometrics';
  }

  if (hasPrint && hasFace) return 'Fingerprint or face unlock';
  if (hasPrint) return 'Fingerprint';
  if (hasFace) return 'Face unlock';
  if (capability.kinds.includes('IRIS')) return 'Iris scan';
  return 'Biometrics';
}
