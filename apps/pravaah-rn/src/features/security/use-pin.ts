import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/api';
import { pinService } from '@/api/security/services';
import type { PinStatusView } from '@/api/security/schemas';

import { authenticateLocally, readBiometricCapability } from './biometric';
import { resolveDeviceId } from './device-identity';

/**
 * The PIN, from the app's side.
 *
 * ## What this hook does NOT do, and why that is the design
 *
 * It never checks a PIN locally, and it never stores one. Every verification is a round trip.
 * That costs a request on the payment path and buys the only thing that makes a six-digit secret
 * worth anything: the attempt counter, the lockout and the bcrypt hash all live somewhere the
 * person holding the handset cannot reach. A locally-compared PIN is a comparison an attacker
 * owns both sides of — patch the branch, or lift the stored hash and grind 10⁶ candidates, which
 * on any modern phone takes about as long as reading this sentence.
 *
 * ## Why `status` is fetched rather than inferred
 *
 * Whether a PIN exists, and whether it is currently locked, are both server facts that change
 * without this app's involvement — a lockout can be triggered from another device, and a reset
 * from support. Caching them locally would produce the worst version of this screen: a PIN field
 * offered to a user whose PIN is locked, accepting six digits and rejecting them, with the real
 * reason arriving only after they have spent an attempt they did not have.
 */

export interface PinState {
  status: PinStatusView | null;
  loading: boolean;
  /** A message ready to render. `null` when there is nothing to say. */
  error: string | null;
  /** True while a mutation is in flight, so the caller can disable its submit. */
  busy: boolean;
}

export interface UsePinResult extends PinState {
  refresh: () => Promise<void>;
  /** Enrol a first PIN. Requires the device to be bound server-side. */
  enrol: (pin: string) => Promise<boolean>;
  /**
   * Change an existing PIN. Raises the OS biometric prompt first and refuses the device
   * passcode — see {@link changePin} for why that refusal is the point.
   */
  change: (newPin: string) => Promise<ChangeOutcome>;
  /** Ask for the SMS code that authorises a reset. */
  requestReset: () => Promise<{ nonce: string } | null>;
  /** Complete a reset. Costs a 24-hour device cooling-off, which the UI must have disclosed. */
  reset: (params: {
    newPin: string;
    nonce: string;
    answer: string;
  }) => Promise<boolean>;
  /** Record what the OS reports about local authentication. Idempotent. */
  recordBiometric: () => Promise<boolean>;
}

export type ChangeOutcome =
  | { ok: true }
  /** The biometric did not pass. `canResetInstead` tells the UI whether to offer the SMS route. */
  | { ok: false; message: string; canResetInstead: boolean };

export function usePin(enabled = true): UsePinResult {
  const [state, setState] = useState<PinState>({
    status: null,
    loading: enabled,
    error: null,
    busy: false,
  });

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const status = await pinService.status();
      if (!alive.current) return;
      setState((prev) => ({ ...prev, status, loading: false, error: null }));
    } catch (error) {
      if (!alive.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: messageFor(error, 'We could not read your security settings.'),
      }));
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enrol = useCallback(async (pin: string) => {
    setState((prev) => ({ ...prev, busy: true, error: null }));
    try {
      /**
       * The device id goes with the PIN, and the server REFUSES an unbound one.
       *
       * The PIN is one half of a two-factor pair whose other half is the bound device, so
       * enrolling from a device the server has never seen would create a knowledge factor with
       * nothing to pair against — and hand an attacker who has only the session a way to
       * manufacture a factor the user has never heard of.
       */
      const deviceId = await resolveDeviceId();
      const status = await pinService.set(pin, deviceId);
      if (!alive.current) return true;
      setState((prev) => ({ ...prev, status, busy: false, error: null }));

      /**
       * Record the biometric right after enrolling, best-effort.
       *
       * The two belong together — a user who just set a PIN on a device with a fingerprint has
       * both factors, and the server should know it so the console does not report the account
       * as PIN-only. A failure here is swallowed because the PIN enrolment already SUCCEEDED,
       * and surfacing a secondary bookkeeping error would read as the PIN having failed.
       */
      void recordBiometricLevel();
      return true;
    } catch (error) {
      if (!alive.current) return false;
      setState((prev) => ({
        ...prev,
        busy: false,
        error: messageFor(error, 'We could not set your PIN. Please try again.'),
      }));
      return false;
    }
  }, []);

  /**
   * Change the PIN, gated on a real biometric.
   *
   * ## The order of operations, which is the whole security argument
   *
   *  1. Ask the SERVER for a challenge. It mints a nonce and a random `assertion`.
   *  2. Raise the OS biometric prompt, with the device passcode DISABLED.
   *  3. Only on a pass, send `{newPin, nonce, assertion}`.
   *
   * The app never sends a "biometric passed" boolean, and there is no field for one. That is
   * the control: a boolean on the wire is an assertion, and the server has no way to check an
   * assertion. Because the `assertion` value is minted server-side and echoed back, possession
   * of it proves the app both received the challenge AND reached step 3 — and the challenge is
   * marked spent on use, so one biometric authorises exactly one change.
   *
   * ## Why the device passcode is refused
   *
   * This is the single most important line in the flow. The dominant real threat to a payment
   * PIN is somebody holding the unlocked handset who watched the owner type the unlock code — a
   * partner, a thief who shoulder-surfed on a train. If the passcode could authorise a PIN
   * change, that person changes the PIN to one they know, and the PIN has protected nothing: the
   * factor collapses into "can you unlock this phone", which possession already answered.
   *
   * The cost is real and accepted: a user with no biometric enrolled cannot change their PIN
   * this way. They get the SMS reset instead, which is deliberately slower and carries a
   * cooling-off — and `canResetInstead` is what tells the UI to offer it.
   */
  const change = useCallback(async (newPin: string): Promise<ChangeOutcome> => {
    setState((prev) => ({ ...prev, busy: true, error: null }));

    const finish = (outcome: ChangeOutcome): ChangeOutcome => {
      if (alive.current) {
        setState((prev) => ({
          ...prev,
          busy: false,
          error: outcome.ok ? null : outcome.message,
        }));
      }
      return outcome;
    };

    const capability = await readBiometricCapability();
    if (!capability.canUseBiometric) {
      /**
       * Checked BEFORE asking the server, so no challenge is minted that cannot be answered.
       *
       * Issuing one anyway would leave a PENDING row the user has no route to satisfy, and
       * `StepUpService.issue` expires the previous challenge each time — so a user tapping
       * "change PIN" repeatedly would accumulate dead rows and, worse, burn their
       * cross-challenge failure budget on challenges they were never able to attempt.
       */
      return finish({
        ok: false,
        message:
          'Changing your PIN needs a fingerprint or face check. Set one up in your phone settings, or reset your PIN with an SMS code instead.',
        canResetInstead: true,
      });
    }

    let nonce: string;
    let assertion: string;
    try {
      const challenge = await pinService.requestChange();
      if (!challenge.assertion) {
        /**
         * A biometric challenge with no assertion cannot be answered.
         *
         * Should be unreachable — the server populates it for `BIOMETRIC` — so this is a guard
         * against a contract drift rather than an expected branch. Failing loudly here is much
         * better than sending an empty string, which the server would compare and reject as a
         * failed attempt, spending one of the user's three.
         */
        return finish({
          ok: false,
          message: 'We could not start the change. Please try again.',
          canResetInstead: true,
        });
      }
      nonce = challenge.nonce;
      assertion = challenge.assertion;
    } catch (error) {
      return finish({
        ok: false,
        message: messageFor(error, 'We could not start the change.'),
        canResetInstead: true,
      });
    }

    const local = await authenticateLocally({
      reason: 'Confirm it is you to change your Pravaah PIN',
      allowDeviceCredential: false,
      requireStrong: true,
      cancelLabel: 'Cancel',
    });

    if (!local.ok) {
      return finish({
        ok: false,
        message: local.message,
        /**
         * Offer the SMS route for every failure EXCEPT a plain dismissal.
         *
         * A user who cancelled did not fail to authenticate — they changed their mind, and
         * pushing them toward a slower path with a cooling-off attached would be answering a
         * question they did not ask. Every other failure means the biometric route is not
         * available to them right now, and the reset is the honest alternative.
         */
        canResetInstead: local.failure !== 'CANCELLED',
      });
    }

    try {
      const status = await pinService.change({ newPin, nonce, assertion });
      if (alive.current) {
        setState((prev) => ({ ...prev, status, busy: false, error: null }));
      }
      return { ok: true };
    } catch (error) {
      return finish({
        ok: false,
        message: messageFor(error, 'We could not change your PIN.'),
        canResetInstead: false,
      });
    }
  }, []);

  const requestReset = useCallback(async () => {
    setState((prev) => ({ ...prev, busy: true, error: null }));
    try {
      const challenge = await pinService.requestReset();
      if (alive.current) setState((prev) => ({ ...prev, busy: false }));
      return { nonce: challenge.nonce };
    } catch (error) {
      if (alive.current) {
        setState((prev) => ({
          ...prev,
          busy: false,
          error: messageFor(error, 'We could not send a code. Please try again.'),
        }));
      }
      return null;
    }
  }, []);

  const reset = useCallback(
    async (params: { newPin: string; nonce: string; answer: string }) => {
      setState((prev) => ({ ...prev, busy: true, error: null }));
      try {
        const status = await pinService.reset(params);
        if (alive.current) {
          setState((prev) => ({ ...prev, status, busy: false, error: null }));
        }
        return true;
      } catch (error) {
        if (alive.current) {
          setState((prev) => ({
            ...prev,
            busy: false,
            error: messageFor(error, 'We could not reset your PIN.'),
          }));
        }
        return false;
      }
    },
    [],
  );

  const recordBiometric = useCallback(async () => {
    const status = await recordBiometricLevel();
    if (status && alive.current) {
      setState((prev) => ({ ...prev, status }));
    }
    return Boolean(status);
  }, []);

  return { ...state, refresh, enrol, change, requestReset, reset, recordBiometric };
}

/**
 * Tell the server the strongest factor this handset has, if any.
 *
 * Returns `null` rather than throwing, because every caller treats this as bookkeeping alongside
 * an operation that has already succeeded. `NONE` is not sent — there is nothing to record about
 * a device with no lock screen, and writing one would overwrite a genuine earlier enrolment from
 * a user who has since turned their screen lock off, making the account look less protected than
 * its history shows.
 */
async function recordBiometricLevel(): Promise<PinStatusView | null> {
  try {
    const capability = await readBiometricCapability();
    if (capability.level === 'NONE') return null;
    return await pinService.enrolBiometric(capability.level);
  } catch {
    return null;
  }
}

/**
 * The server's message when it sent one, ours otherwise.
 *
 * The server's is nearly always the better text here, because it is the only side that knows the
 * fact the user needs: "2 attempts remaining", "locked for 15 minutes", "that PIN is too easy to
 * guess". A generic client string would replace a specific, actionable message with a shrug.
 */
function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) return error.message;
  return fallback;
}
