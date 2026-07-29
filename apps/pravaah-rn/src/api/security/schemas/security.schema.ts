import type {
  DeviceIntegrity,
  DeviceStatus,
  HoldStatus,
  RiskDecision,
  RiskSubjectType,
  StepUpMethod,
  StepUpPurpose,
} from './vocabulary';

/** Devices, challenges, and the transparency views. */

/**
 * What the app reports about itself on a bind and on sensitive actions.
 *
 * Every field is a CLAIM by the client, not a fact, and the server treats it that way —
 * the integrity verdict is scored, not trusted. The reason to send it anyway is that an
 * attacker operating an emulator farm usually cannot be bothered to spoof consistently,
 * and the inconsistency is itself the signal.
 */
export interface DeviceContext {
  /** This installation's id. A uuid, minted once and persisted. */
  deviceId: string;
  platform: 'ios' | 'android' | 'web';
  /**
   * The SIM's ICCID. Hashed server-side before storage and never logged.
   *
   * Optional because iOS does not expose it and a web client has no SIM at all. Absent
   * means swap detection is unavailable for this device, which the server scores as
   * reduced assurance rather than treating as a pass.
   */
  simSerial?: string;
  integrity: DeviceIntegrity;
  model?: string;
  osVersion?: string;
  appVersion?: string;
  /**
   * A country or country-region code — `SG`, `IN-MH`. Never a coordinate.
   *
   * Enough to catch impossible travel, which is the only thing it is used for. A
   * latitude would make this a location-tracking field under a far heavier DPDP consent
   * and retention regime, for no additional detection.
   */
  geoHint?: string;
}

/** A registered device, as the user sees it in the manager. */
export interface DeviceView {
  id: string;
  deviceId: string;
  platform: string;
  status: DeviceStatus;
  integrity: DeviceIntegrity;
  coolingOffUntil: string | null;
  boundAt: string | null;
  lastSeenAt: string;
  createdAt: string;
  swapDetectedAt: string | null;
  /**
   * Computed server-side, so the app can explain friction BEFORE the user types an
   * amount rather than after they have been challenged.
   */
  inCoolingOff: boolean;
}

/**
 * A challenge the user must answer.
 *
 * `nonce` is an IDENTIFIER, not a secret. The secret is the CODE, which Twilio Verify
 * generates and sends — the server never sees it either, so there is nothing here that could
 * leak it. Testing without a live SMS goes through the auth dev-bypass number.
 */
export interface StepUpChallenge {
  nonce: string;
  method: StepUpMethod;
  purpose?: StepUpPurpose;
  expiresAt: string;
  /** Plain-language "why", written to feel protective rather than accusatory. */
  reason?: string;
  /** How many guesses are LEFT. Absent on a freshly issued challenge. */
  attemptsRemaining?: number;
  /**
   * The secret a BIOMETRIC challenge must echo back. Present ONLY for `method: 'BIOMETRIC'`.
   *
   * A biometric check happens on the handset, so unlike an OTP there is no out-of-band channel
   * to deliver anything through — the server hands the app a value and accepts it back once the
   * OS reports a passing check.
   *
   * Absent for `PIN_REAUTH`, and that absence is the design rather than an omission: a PIN's
   * answer is the PIN, checked server-side against the stored hash. Handing the app a secret to
   * echo would make the PIN something the app can assert instead of something the user knows.
   */
  assertion?: string;
}

/** What `POST /devices/bind` answers. A ticket and a challenge, never a token. */
export interface BindTicket {
  deviceRef: string;
  status: DeviceStatus;
  /**
   * `null` when the device was already ACTIVE.
   *
   * An app that reinstalled and kept its installation id should not be forced through a
   * challenge it already passed, so re-binding is a no-op that reports itself.
   */
  stepUp: StepUpChallenge | null;
  /** What the engine noticed, so the app can be honest about the friction. */
  riskReasons?: string[];
}

/**
 * What completing a bind returns. The binding token arrives exactly ONCE.
 *
 * Only its hash is stored server-side, so a lost token cannot be recovered — the device
 * re-binds instead. Same discipline as an OTP, and for the same reason: a device-binding
 * token readable from a database backup is a device binding an attacker can assume
 * without ever touching the handset.
 */
export interface BindResult {
  deviceRef: string | null;
  bindingToken?: string;
  coolingOff: boolean;
}

export interface RefreshResult {
  deviceRef: string;
  bindingToken: string;
  rotatedAt: string;
}

/**
 * One past decision, as the USER is shown it.
 *
 * Note what is absent: the numeric score, the signal types, and the weights. That is a
 * security property rather than coyness — a precise score turns the endpoint into a
 * calibration oracle, letting somebody tune inputs until it drops below a threshold they
 * can observe. A person is owed an explanation of a decision about them; they are not
 * owed the detector's specification.
 */
export interface SecurityActivityView {
  id: string;
  subjectType: RiskSubjectType;
  decision: RiskDecision;
  computedAt: string;
  reasons: string[];
}

/**
 * A held action, with a reference support can quote.
 *
 * The `reference` IS the analyst's case id, deliberately: it ties a customer's complaint
 * to the exact signal trail a reviewer will read, with no lookup in between.
 */
export interface HoldView {
  reference: string;
  subjectType: RiskSubjectType;
  subjectId: string;
  status: HoldStatus;
  openedAt: string;
  reasons: string[];
}

/** The step-up verify response. `bindingToken` only on a DEVICE_BIND challenge. */
export interface StepUpResult {
  ok: boolean;
  purpose: StepUpPurpose;
  subjectId: string | null;
  bindingToken?: string;
}

/**
 * Whether this account has an app PIN, and whether it can be used right now.
 *
 * `enrolled` and `locked` are separate booleans and both are load-bearing. An enrolled but
 * locked PIN must not be offered — the field would accept input and reject every one of them,
 * with the real reason ("locked for 15 minutes") arriving only after the user has typed six
 * digits and lost an attempt they did not have.
 */
export interface PinStatusView {
  enrolled: boolean;
  /** True while a lockout is running. The app must show the reset route, not a PIN field. */
  locked: boolean;
  /** ISO. When the lockout lifts. `null` when not locked. */
  lockedUntil: string | null;
  /**
   * Guesses left before a lockout. `null` when not enrolled.
   *
   * Shown to the user once it drops below the maximum, and NOT before. Displaying "5 attempts
   * remaining" on a fresh screen invents an anxiety the user did not have; showing "1 attempt
   * remaining" prevents a lockout they would not otherwise see coming.
   */
  attemptsRemaining: number | null;
  /** Whether a biometric was ever recorded for this account. Gates the PIN-change route. */
  biometricEnrolled: boolean;
  /** The strongest level the device reported at enrolment. A claim, not proof. */
  biometricLevel: string | null;
}
