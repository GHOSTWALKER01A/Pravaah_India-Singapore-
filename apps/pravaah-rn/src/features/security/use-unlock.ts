import { useCallback, useEffect, useRef, useState } from 'react';

import { deviceService } from '@/api/security/services';
import type { DeviceView } from '@/api/security/schemas';

import {
  biometricLabel,
  readBiometricCapability,
  type BiometricCapability,
} from './biometric';
import { resolveDeviceId } from './device-identity';
import {
  forgetSession,
  readSessionMarker,
  restoreSession,
  type RestoreFailure,
} from './session-vault';

/**
 * The launch gate: decide, on cold start, whether this person gets straight back in.
 *
 * ## The three outcomes, and why they are three and not two
 *
 *  - **`signed-out`** — nothing was stored. The phone-number screen, as before. No prompt, no
 *    explanation needed, because nothing was lost.
 *  - **`locked`** — a session exists and is waiting behind the device's own authentication.
 *    One tap and they are in.
 *  - **`restored`** — the token was released, exchanged for a live pair, and the profile
 *    re-fetched.
 *
 * The middle state is the one a naive implementation collapses. If "has a stored session" and
 * "has a live session" are one boolean, the app must prompt during render to tell them apart —
 * and a biometric sheet that appears because a component mounted is a sheet that appears twice
 * on a fast remount, on every navigation that unmounts the tree, and in the middle of a
 * `StrictMode` double-render. Keeping `locked` explicit means the prompt is only ever raised by
 * something the user did.
 *
 * ## Why a passing biometric is not always enough
 *
 * This is the part that a working implementation would still get wrong. The OS answers exactly
 * one question — "is this the enrolled owner of this handset?" — and there are two situations
 * where the honest answer is yes and restoring the session is still the wrong thing to do:
 *
 *  1. **The server has flagged this device `SUSPECTED_SWAP`.** The SIM changed. The biometric
 *     still passes because the biometric was never about the SIM. But a SIM swap is the opening
 *     move of an account takeover, and the person holding the phone may have enrolled their own
 *     fingerprint after acquiring it. A full sign-in re-anchors the session against the number.
 *
 *  2. **The device reports as revoked.** The user pressed "this wasn't me" from another handset.
 *     Honouring a local biometric after that would make the revoke button decorative — the
 *     panic control that must work when nothing else does.
 *
 * So the restore is CONFIRMED against the server before the session is handed over, and the
 * check happens after the exchange (an authenticated call needs a token) but before the caller
 * is told it succeeded. A failure there does not merely refuse: it calls {@link forgetSession},
 * because a session the server distrusts should stop being unlockable at all.
 *
 * ## Why integrity is NOT checked here
 *
 * A rooted device is exactly the device whose self-report is worthless, so refusing on the
 * app's own `readIntegrity()` verdict would be security theatre — an attacker patches the check
 * out. Integrity is a server-side SIGNAL, weighted at 0.45 in the risk engine, and it does its
 * work where it cannot be patched: on the payment. A rooted handset can unlock the app and then
 * finds every transfer challenged.
 */

export type UnlockPhase =
  /** Still reading the marker. Show the splash, never a login form. */
  | 'checking'
  /** No stored session. Show the phone-number screen. */
  | 'signed-out'
  /** A session is stored, waiting for the OS prompt. Show the unlock screen. */
  | 'locked'
  /** The OS prompt is open, or the exchange is in flight. */
  | 'unlocking'
  /** Signed in. The caller has a live session. */
  | 'restored';

export interface UnlockState {
  phase: UnlockPhase;
  /** What the device can do, for the button label and the fallback copy. */
  capability: BiometricCapability | null;
  /** "Face ID", "Fingerprint", "Device unlock" — whatever this handset actually offers. */
  label: string;
  /**
   * Why the last attempt did not get in. `null` before the first attempt.
   *
   * Kept distinct from `phase` because a failure does not always change the phase: a declined
   * prompt leaves the session `locked` and retryable, and conflating the two would either lose
   * the message or strand the user on a screen with no way forward.
   */
  failure: RestoreFailure | null;
  /** Plain-language `failure`, ready to render. */
  message: string | null;
}

export interface UseUnlockResult extends UnlockState {
  /** Raise the OS prompt and restore. Safe to call repeatedly; concurrent calls are ignored. */
  unlock: () => Promise<void>;
  /** Give up on the stored session and sign in with a code instead. */
  signInWithCode: () => Promise<void>;
}

/**
 * @param restore Exchange the token and hydrate the user. Supplied by the auth context, which
 *   owns the session — this hook decides WHETHER to restore, never what a session is.
 * @param autoPrompt Whether to raise the prompt as soon as a stored session is found. True on a
 *   cold start, so the common case is one tap on the OS sheet rather than a tap to ask for it.
 */
export function useUnlock(params: {
  restore: (refreshToken: string, userId: string) => Promise<void>;
  autoPrompt?: boolean;
}): UseUnlockResult {
  const [state, setState] = useState<UnlockState>({
    phase: 'checking',
    capability: null,
    label: 'Device unlock',
    failure: null,
    message: null,
  });

  const alive = useRef(true);
  /**
   * One attempt at a time.
   *
   * Two overlapping `getItemAsync` calls with `requireAuthentication` raise two OS sheets, and
   * on Android the second can cancel the first — so a double tap would reliably fail an unlock
   * that a single tap succeeds at. A ref rather than state because the guard must hold within a
   * single tick, before any re-render.
   */
  const running = useRef(false);
  /** So `autoPrompt` fires once per mount and not on every state change. */
  const prompted = useRef(false);

  /**
   * `restore` held in a ref, and read at call time.
   *
   * The caller passes a fresh object literal every render, so depending on it directly would
   * rebuild `unlock` on each render — and `unlock` is the identity the mount effect's auto-prompt
   * is guarded against. An unstable one means the guard is comparing against something that keeps
   * changing, and the OS prompt fires again on a render the user did not cause.
   *
   * A ref rather than `useCallback` on the caller's side because this hook cannot enforce that,
   * and a hook whose correctness depends on the caller remembering to memoise is a hook that will
   * eventually be called wrong.
   *
   * Synced in an EFFECT rather than assigned during render. Writing a ref while rendering is a
   * real hazard, not a lint preference: React may render a component and discard the result, and
   * a ref written on the discarded pass keeps the value from a render that never committed.
   */
  const restoreRef = useRef(params.restore);
  useEffect(() => {
    restoreRef.current = params.restore;
  }, [params.restore]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const unlock = useCallback(async () => {
    if (running.current) return;
    running.current = true;

    setState((prev) => ({
      ...prev,
      phase: 'unlocking',
      failure: null,
      message: null,
    }));

    try {
      const result = await restoreSession();

      if (!result.ok) {
        if (!alive.current) return;
        /**
         * `DECLINED` stays `locked`; everything else becomes `signed-out`.
         *
         * The distinction is whether the token still exists. A declined prompt left it intact,
         * so another tap can get it — dropping to `signed-out` there would sign out every user
         * who dismissed the sheet by accident. The other failures already deleted it, so
         * offering "unlock" again would raise a prompt for something that is gone.
         */
        setState((prev) => ({
          ...prev,
          phase: result.failure === 'DECLINED' ? 'locked' : 'signed-out',
          failure: result.failure,
          message: messageForFailure(result.failure, prev.label),
        }));
        return;
      }

      await restoreRef.current(
        result.session.refreshToken,
        result.session.userId,
      );

      /**
       * Now confirm the SERVER still trusts this device — after the exchange, because the check
       * needs a token, and before reporting success, because that is the whole point.
       */
      const verdict = await confirmDeviceTrust();
      if (!verdict.ok) {
        await forgetSession();
        if (!alive.current) return;
        setState((prev) => ({
          ...prev,
          phase: 'signed-out',
          failure: 'INVALIDATED',
          message: verdict.message,
        }));
        return;
      }

      if (!alive.current) return;
      setState((prev) => ({
        ...prev,
        phase: 'restored',
        failure: null,
        message: null,
      }));
    } catch {
      /**
       * The exchange itself failed — an expired refresh token, or no network.
       *
       * The stored session is dropped, because a refresh token the server refused cannot be
       * recovered on the client. A network failure is swept up with it, and that is the
       * deliberately conservative reading: one extra sign-in for somebody launching the app on
       * a dead connection, rather than a session left unlockable that may already be revoked.
       */
      await forgetSession();
      if (!alive.current) return;
      setState((prev) => ({
        ...prev,
        phase: 'signed-out',
        failure: 'EXPIRED',
        message: 'Your session has ended. Please sign in again.',
      }));
    } finally {
      running.current = false;
    }
  }, []);

  const signInWithCode = useCallback(async () => {
    await forgetSession();
    if (!alive.current) return;
    setState((prev) => ({
      ...prev,
      phase: 'signed-out',
      failure: null,
      message: null,
    }));
  }, []);

  // Read the marker once on mount, and prompt immediately if there is something to unlock.
  useEffect(() => {
    void (async () => {
      const [marker, capability] = await Promise.all([
        readSessionMarker(),
        readBiometricCapability(),
      ]);
      if (!alive.current) return;

      const label = biometricLabel(capability);

      if (!marker.present) {
        setState({
          phase: 'signed-out',
          capability,
          label,
          failure: null,
          message: null,
        });
        return;
      }

      setState({
        phase: 'locked',
        capability,
        label,
        failure: null,
        message: null,
      });

      if ((params.autoPrompt ?? true) && !prompted.current) {
        prompted.current = true;
        await unlock();
      }
    })();
    // `unlock` is stable via useCallback; re-running this effect would re-prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...state, unlock, signInWithCode };
}

/**
 * Does the server still consider this device fit to carry a session?
 *
 * Fails CLOSED on a refusal and OPEN on an unreachable server, and the asymmetry is deliberate.
 * A `SUSPECTED_SWAP` verdict is information we must act on. A network error is the absence of
 * information — and treating it as a refusal would mean nobody could open the app offline, which
 * turns a transient outage into a total lockout for every user at once. The payment path is
 * where an offline device is actually stopped, and it cannot be reached without a server anyway.
 */
async function confirmDeviceTrust(): Promise<{ ok: true } | { ok: false; message: string }> {
  let devices: DeviceView[];
  let deviceId: string;
  try {
    [devices, deviceId] = await Promise.all([
      deviceService.list(),
      resolveDeviceId(),
    ]);
  } catch {
    return { ok: true };
  }

  const mine = devices.find((device) => device.deviceId === deviceId);

  /**
   * An UNKNOWN device passes.
   *
   * It is the ordinary state of a device whose bind never completed, and refusing would strand
   * exactly the users the bind flow already handles by challenging them. What must not pass is a
   * device the server has an explicit negative opinion about.
   */
  if (!mine) return { ok: true };

  if (mine.status === 'REVOKED') {
    return {
      ok: false,
      message:
        'This device was signed out from your account. Sign in with a code to use it again.',
    };
  }

  if (mine.status === 'SUSPECTED_SWAP') {
    return {
      ok: false,
      message:
        'Your SIM has changed since you last signed in. For your security, please sign in with a code.',
    };
  }

  return { ok: true };
}

function messageForFailure(failure: RestoreFailure, label: string): string {
  switch (failure) {
    case 'DECLINED':
      return `Unlock with ${label.toLowerCase()} to continue.`;
    case 'INVALIDATED':
      /**
       * The honest explanation, because the alternative is a user who believes the app broke.
       *
       * Adding a fingerprint invalidates the key the session was held under — a deliberate OS
       * behaviour, and the right one — but from the user's side the app simply signed them out
       * for no reason they can see. Naming the cause is the difference between a security
       * feature and a bug report.
       */
      return 'Your device security settings changed, so we signed you out to be safe. Please sign in with a code.';
    case 'EXPIRED':
      return 'It has been a while — please sign in again.';
    case 'UNAVAILABLE':
      return 'This device cannot store a saved sign-in. Please sign in with a code.';
    case 'ABSENT':
      return 'Please sign in.';
  }
}
