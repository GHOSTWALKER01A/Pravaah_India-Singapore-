import type {
  DeviceIntegrity,
  DeviceStatus,
  HoldStatus,
  RiskDecision,
  RiskSubjectType,
  StepUpMethod,
} from '@/api/security/schemas';

/**
 * How M6's states are presented to a person.
 *
 * ## The rule this file exists to enforce
 *
 * Security copy is where a product either builds trust or manufactures anxiety, and the
 * difference is almost entirely wording. Three things it refuses to do:
 *
 * 1. **It never accuses.** A held payment is "under review", not "flagged as suspicious".
 *    The overwhelming majority of held actions are legitimate users — false positives are
 *    the EXPECTED case at these thresholds, which is the whole reason a hold is a delay
 *    rather than a decline. Copy that implies guilt is wrong for most of the people who
 *    read it.
 * 2. **It never names a detector.** "Unusual amount from a device added recently" is an
 *    explanation. "MULE_GRAPH fired at 0.55" is a specification, and handing it to an
 *    account under investigation is handing over the evasion instructions.
 * 3. **It never invents a colour system.** Tones map onto the note's two-colour world —
 *    `field` for settled, `latent` for in-flight or attention, `carmine` for the word
 *    under pressure. There is no security-red / all-clear-green rainbow.
 *
 * Every map here is a `Record` keyed on the wire union rather than a lookup with a
 * fallback: adding a state server-side becomes a build failure here, instead of a raw
 * `SCREAMING_CASE` token rendered at a worried user.
 */

/** The same tone vocabulary the payments meta uses, so the two read as one system. */
export type SecurityTone = 'field' | 'latent' | 'carmine' | 'neutral';

// ── devices ─────────────────────────────────────────────────────────────────
export interface DevicePresentation {
  label: string;
  tone: SecurityTone;
  /** One sentence saying what is true now, and what to do if anything. */
  detail: string;
  /** Whether this device can act at all. Only ACTIVE can. */
  usable: boolean;
}

export const DEVICE_STATUS: Record<DeviceStatus, DevicePresentation> = {
  /**
   * A bind nobody finished. Presented as an unfinished setup rather than a problem,
   * because that is what it almost always is — a user who closed the app mid-flow.
   */
  BINDING: {
    label: 'Not finished',
    tone: 'neutral',
    detail: 'Registration for this device was never completed.',
    usable: false,
  },
  ACTIVE: {
    label: 'Registered',
    tone: 'field',
    detail: 'This device can be used normally.',
    usable: true,
  },
  /**
   * The SIM-swap freeze. Written to be ACTIONABLE, because the legitimate reading — the
   * user replaced a damaged SIM — is the common one, and that person needs to know there
   * is a way back rather than that something is wrong with their account.
   */
  SUSPECTED_SWAP: {
    label: 'Needs verifying',
    tone: 'latent',
    detail:
      'The SIM in this device changed. Verify it again to keep sending larger payments.',
    usable: false,
  },
  REVOKED: {
    label: 'Removed',
    tone: 'carmine',
    detail: 'This device can no longer access your account.',
    usable: false,
  },
};

export const DEVICE_INTEGRITY: Record<
  DeviceIntegrity,
  { label: string; tone: SecurityTone; detail: string | null }
> = {
  OK: { label: 'Checks passed', tone: 'field', detail: null },
  /**
   * Surfaced, not hidden. A user whose phone is rooted deserves to know it is why their
   * payments attract extra checks — the alternative is unexplained friction they attribute
   * to the app being broken.
   */
  ROOTED: {
    label: 'Modified device',
    tone: 'latent',
    detail:
      'This device appears to be rooted or jailbroken, so some actions need extra confirmation.',
  },
  EMULATOR: {
    label: 'Emulator',
    tone: 'latent',
    detail: 'This app is running on an emulator rather than a phone.',
  },
  UNKNOWN: {
    label: 'Not checked',
    tone: 'neutral',
    detail: 'This device did not report a security check.',
  },
};

// ── holds ───────────────────────────────────────────────────────────────────
export interface HoldPresentation {
  label: string;
  tone: SecurityTone;
  detail: string;
  /** Whether the user themselves can move this along. */
  actionable: boolean;
}

export const HOLD_STATUS: Record<HoldStatus, HoldPresentation> = {
  /**
   * "Usually minutes" is a promise, and it is one the SLA is set to keep — four hours is
   * the analyst's outer bound, and the queue is ordered longest-waiting-first precisely so
   * this line stays true. Saying it without that ordering behind it would be a lie the
   * product tells at its most sensitive moment.
   */
  UNDER_REVIEW: {
    label: 'Under review',
    tone: 'latent',
    detail:
      'Someone is checking this for your safety. It usually takes minutes.',
    actionable: false,
  },
  ACTION_NEEDED: {
    label: 'We need something from you',
    tone: 'latent',
    detail: 'We have asked you for a detail before this can continue.',
    actionable: true,
  },
};

// ── decisions ───────────────────────────────────────────────────────────────
/**
 * What each outcome MEANT, for the activity list.
 *
 * Past tense throughout: this view is a history, and a user reading it needs to know what
 * happened rather than what is happening. `ALLOW` is included and shown plainly — a
 * transparency screen that only listed the times a user was stopped would read as a
 * rap sheet rather than a record.
 */
export const RISK_DECISION: Record<
  RiskDecision,
  { label: string; tone: SecurityTone }
> = {
  ALLOW: { label: 'Allowed', tone: 'field' },
  /**
   * The shadow-review band. Presented identically to ALLOW because that is what the user
   * EXPERIENCED — the action went through. Telling somebody their completed payment was
   * "sampled for review" invites a support call about a thing that did not affect them.
   */
  REVIEW: { label: 'Allowed', tone: 'field' },
  /**
   * A challenge that the user then PASSED, from their point of view.
   *
   * The assessment records the moment a step-up was demanded, not whether it succeeded — so
   * the honest label for a row the user is reading afterwards is that they confirmed it.
   * A row saying "extra verification required" on a payment that went through minutes ago
   * reads as an unresolved problem.
   */
  STEP_UP: { label: 'Confirmed by you', tone: 'field' },
  HOLD: { label: 'Held for review', tone: 'latent' },
  BLOCK: { label: 'Blocked', tone: 'carmine' },
};

/** What the decision was ABOUT, in the user's own vocabulary. */
export const RISK_SUBJECT: Record<RiskSubjectType, string> = {
  TRANSACTION: 'A payment',
  CLAIM: 'An insurance claim',
  LOGIN: 'A sign-in',
  DEVICE_BIND: 'Registering a device',
  CONSENT: 'A data-sharing request',
  PAYOUT: 'A payout',
};

// ── step-up ─────────────────────────────────────────────────────────────────
export const STEP_UP_METHOD: Record<
  StepUpMethod,
  { title: string; prompt: string; keyboard: 'number-pad' | 'default' }
> = {
  OTP: {
    title: 'Confirm this is you',
    prompt: 'Enter the code we sent to your phone.',
    keyboard: 'number-pad',
  },
  BIOMETRIC: {
    title: 'Confirm this is you',
    prompt: 'Use your fingerprint or face to confirm.',
    keyboard: 'default',
  },
  /**
   * The app's own PIN — NOT the UPI PIN.
   *
   * Worth being explicit in the copy, because a user who is asked for "your PIN" during a
   * payment will reasonably assume the UPI one. That PIN is entered in the bank's secure
   * component and never reaches Pravaah; asking for it here would be indistinguishable
   * from a phishing screen.
   */
  PIN_REAUTH: {
    title: 'Confirm this is you',
    prompt: 'Enter your Pravaah app PIN — not your UPI PIN.',
    keyboard: 'number-pad',
  },
};

/**
 * The digits in an OTP challenge, so the input can size itself.
 *
 * Matches `STEP_UP.OTP_LENGTH` server-side. Hard-coded rather than derived because the
 * challenge response deliberately does not carry it — telling a client how long the secret
 * is, on a per-challenge basis, is a detail a brute-force attempt would appreciate.
 */
export const STEP_UP_OTP_LENGTH = 6;

/**
 * The digits in the app PIN. Matches `PIN_POLICY.LENGTH` server-side.
 *
 * A separate constant from {@link STEP_UP_OTP_LENGTH} even though both are 6, because they are
 * two unrelated policies that happen to agree today. Sharing one would mean a change to the OTP
 * length silently resizing every PIN field in the app — and a PIN field that accepts a different
 * number of digits than the server hashes is a lockout for everyone who enrolled before the
 * change.
 */
export const PIN_LENGTH = 6;

/**
 * Below this, a clean domestic payment asks for nothing. ₹500, in rupees for display.
 *
 * NPCI's own UPI Lite line, adopted rather than invented — see `PIN_POLICY.EXEMPT_BELOW_MINOR`.
 * Held here purely so the setup screen can tell the user where the boundary is; nothing decides
 * anything from this value, because the decision is the server's and a client-side copy of a
 * threshold is a client-side copy of a control.
 */
export const PIN_EXEMPT_BELOW_RUPEES = 500;

// ── time ────────────────────────────────────────────────────────────────────
/**
 * "Expires in 4:12", or null once it has lapsed.
 *
 * Returns null rather than "0:00" so a caller can distinguish "still counting" from
 * "gone" and change the button rather than showing a dead timer.
 */
export function formatExpiry(expiresAt: string, now: number): string | null {
  const remaining = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;

  const totalSeconds = Math.ceil(remaining / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * How long is left on a device's cooling-off, in words.
 *
 * Rounded UP to the hour, and coarse on purpose. A precise countdown invites a user to
 * wait it out, and the window is not a punishment to be served — it is a period in which
 * large payments get a second factor. "About 3 hours" is enough to explain the friction
 * without turning it into a timer.
 */
export function formatCoolingOff(
  coolingOffUntil: string | null,
  now: number,
): string | null {
  if (!coolingOffUntil) return null;
  const remaining = new Date(coolingOffUntil).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;

  const hours = Math.ceil(remaining / 3_600_000);
  if (hours <= 1) return 'about an hour';
  return `about ${hours} hours`;
}

/** "2 minutes ago" / "3 days ago", for a device's last-seen line. */
export function formatLastSeen(iso: string, now: number): string {
  const elapsed = now - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return 'unknown';
  if (elapsed < 60_000) return 'just now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Whether this row is the device the app is currently running on. */
export function isThisDevice(
  row: { deviceId: string },
  localDeviceId: string | null,
): boolean {
  return localDeviceId !== null && row.deviceId === localDeviceId;
}
