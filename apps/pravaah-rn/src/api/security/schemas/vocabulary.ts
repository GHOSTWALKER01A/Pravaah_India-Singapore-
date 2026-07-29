/**
 * The M6 wire vocabulary.
 *
 * Mirrors the Prisma enums the security API sends. Kept as unions rather than `string`,
 * for the reason the payments and insurance vocabularies both state: a
 * `Record<string, …>` lookup keyed on a widened type means adding a state to the
 * backend leaves this app compiling happily while rendering a raw `SCREAMING_CASE`
 * token at a user. Keyed on the union, the same change is a build failure here first —
 * which is the only place it is cheap to fix.
 */

/**
 * A device's lifecycle state.
 *
 * `BINDING` is NOT a bound device — it is a bind whose challenge was never answered.
 * The distinction is load-bearing: treating it as bound would let anyone who started a
 * bind act as though they had finished one.
 */
export type DeviceStatus = 'BINDING' | 'ACTIVE' | 'REVOKED' | 'SUSPECTED_SWAP';

/**
 * The app's own attestation verdict.
 *
 * `UNKNOWN` is a distinct value from `OK`, and the distinction is the control: a client
 * that did not run the check has not passed it. Treating a missing verdict as OK is how
 * an attacker opts out of integrity checking by omitting a field.
 */
export type DeviceIntegrity = 'OK' | 'ROOTED' | 'EMULATOR' | 'UNKNOWN';

/**
 * The five risk outcomes.
 *
 * The app only ever RECEIVES these on an assessment record — never as a thing to act
 * on directly. What it acts on is the presence of a `stepUp` challenge or a `RISK_HELD`
 * status, because those are facts about the action rather than about the model.
 */
export type RiskDecision = 'ALLOW' | 'REVIEW' | 'STEP_UP' | 'HOLD' | 'BLOCK';

export type RiskSubjectType =
  | 'TRANSACTION'
  | 'CLAIM'
  | 'LOGIN'
  | 'DEVICE_BIND'
  | 'CONSENT'
  | 'PAYOUT';

export type StepUpMethod = 'OTP' | 'BIOMETRIC' | 'PIN_REAUTH';

/**
 * What a challenge authorises.
 *
 * Sent on every request and re-checked server-side against the challenge it was issued
 * for. Without that check a code issued for a ₹100 transfer could be redeemed against a
 * ₹100,000 one — so this is not a label, it is half of a scoping guarantee.
 */
export type StepUpPurpose =
  | 'DEVICE_BIND'
  | 'DEVICE_RECOVERY'
  | 'TRANSACTION'
  | 'CLAIM'
  | 'LOGIN'
  | 'CONSENT';

/**
 * The status of a held action, as the USER is shown it.
 *
 * A deliberately narrower vocabulary than the analyst's `FraudCaseStatus`.
 * `INVESTIGATING` tells a customer nothing and reads as an accusation; the server maps
 * its own states onto these two before they leave the building.
 */
export type HoldStatus = 'UNDER_REVIEW' | 'ACTION_NEEDED';
