import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type { PinStatusView, StepUpChallenge } from '../schemas';

/**
 * The app PIN — enrol, verify, change, reset.
 *
 * ## What is deliberately NOT here
 *
 * No local verification, and no cached copy of the PIN or a hash of it. Every check is a round
 * trip. That costs a request on the payment path and it is the entire point: a PIN compared on
 * the handset is a comparison an attacker with the handset controls both sides of — patch the
 * comparison, or read the stored hash and grind it offline against 10⁶ candidates, which takes
 * seconds. Server-side means the attempt counter, the lockout and the hash all live somewhere
 * the attacker does not.
 *
 * ## Why the two `request` calls exist separately from the mutations
 *
 * A change and a reset each need a challenge PASSED first, and the two challenges are
 * different factors on purpose — biometric for a change, SMS for a reset. Issuing them through
 * one endpoint would let the SMS code from a reset be redeemed against a change, which is
 * exactly the bypass the split prevents: read the code off the stolen handset's lock screen,
 * set your own PIN, keep the account.
 */
class PinService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.SECURITY.BASE);
  }

  /** Whether a PIN exists and can be used now. Read before showing any PIN field. */
  status(): Promise<PinStatusView> {
    return this.get<PinStatusView>(API_ENDPOINTS.SECURITY.PIN_STATUS);
  }

  /**
   * Enrol a PIN for the first time.
   *
   * `deviceId` is required by the server, which REFUSES enrolment from a device it has not
   * bound. The PIN is one half of a pair whose other half is the bound device, so enrolling
   * from an unrecognised one would create a factor with nothing to pair against.
   */
  set(pin: string, deviceId: string): Promise<PinStatusView> {
    return this.post<PinStatusView>(API_ENDPOINTS.SECURITY.PIN_SET, {
      pin,
      deviceId,
    });
  }

  /**
   * Answer a PIN challenge outside a specific action's own flow.
   *
   * Note that the flows which ACT on a PIN — releasing a stepped-up transfer — use their own
   * endpoint instead, so they can assert the purpose and subject they expect. This one is for
   * confirming the PIN works, such as immediately after enrolling it.
   */
  verify(pin: string): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>(API_ENDPOINTS.SECURITY.PIN_VERIFY, {
      pin,
    });
  }

  /**
   * Ask for the BIOMETRIC challenge that authorises a PIN change.
   *
   * Returns a nonce and an `assertion` — a random secret the app echoes back only after the OS
   * reports a passing fingerprint or face check. The assertion is what makes the nonce proof
   * rather than a claim: without it the app could assert that a biometric happened.
   */
  requestChange(): Promise<StepUpChallenge> {
    return this.post<StepUpChallenge>(
      API_ENDPOINTS.SECURITY.PIN_CHANGE_REQUEST,
    );
  }

  /**
   * Change the PIN.
   *
   * No current PIN, by design: the biometric proving this request is a STRONGER factor than
   * the PIN being replaced, so asking for both adds friction without assurance — anyone who
   * can pass the biometric can already authorise a payment.
   */
  change(params: {
    newPin: string;
    nonce: string;
    assertion: string;
  }): Promise<PinStatusView> {
    return this.post<PinStatusView>(API_ENDPOINTS.SECURITY.PIN_CHANGE, params);
  }

  /** Ask for the SMS challenge that authorises a reset. Sent to the registered number. */
  requestReset(): Promise<StepUpChallenge> {
    return this.post<StepUpChallenge>(API_ENDPOINTS.SECURITY.PIN_RESET_REQUEST);
  }

  /**
   * Reset a forgotten or locked PIN.
   *
   * Costs a 24-hour device cooling-off, and the app says so BEFORE the user commits. A reset
   * proved only by SMS would otherwise be a way around the PIN itself — somebody holding the
   * unlocked phone reads the code, resets, and pays. The cooling-off turns "reset and drain"
   * into "reset, then wait while somebody reviews it", and hiding that cost would make the
   * later friction feel like a malfunction.
   */
  reset(params: {
    newPin: string;
    nonce: string;
    answer: string;
  }): Promise<PinStatusView> {
    return this.post<PinStatusView>(API_ENDPOINTS.SECURITY.PIN_RESET, params);
  }

  /**
   * Tell the server what the OS reports about local authentication.
   *
   * Recorded as a CLAIM, never as proof — the check happens on the handset, so
   * `BIOMETRIC_STRONG` from a rooted device is worth exactly what that device's integrity
   * signal says it is worth. It is sent so the account has a recorded second factor and the
   * console can see which accounts genuinely have one.
   */
  enrolBiometric(
    level: 'NONE' | 'SECRET' | 'BIOMETRIC_WEAK' | 'BIOMETRIC_STRONG',
  ): Promise<PinStatusView> {
    return this.post<PinStatusView>(API_ENDPOINTS.SECURITY.BIOMETRIC_ENROL, {
      level,
    });
  }
}

export const pinService = new PinService();
