import { useCallback, useEffect, useRef, useState } from 'react';

import { deviceService } from '@/api/security/services';
import type { StepUpChallenge } from '@/api/security/schemas';

import {
  clearDeviceBindSnooze,
  isDeviceBindSnoozed,
  readDeviceContext,
  resolveDeviceId,
  snoozeDeviceBind,
} from './device-identity';

/**
 * Bind this device, once, in the background.
 *
 * ## Why binding happens on BOOT rather than when the user first sends money
 *
 * The cooling-off window is the point. A device bound at the moment of a large transfer is
 * a device in minute one of its window — maximum friction, exactly when the user least
 * wants it. Binding at first sign-in instead means the clock is already running by the time
 * they need it, so ordinary users are challenged once, quietly, on a screen where a code is
 * expected.
 *
 * The attacker's experience is unchanged: they bind at takeover time and hit the wall on
 * their first big transfer. That asymmetry is the whole design — the same control costs a
 * real user one tap at setup and costs an attacker their objective.
 *
 * ## Why a failure here is SILENT
 *
 * This runs on every launch and the user did not ask for it. A blocking error, a toast, or
 * a modal would be the app interrupting somebody to report a background maintenance
 * failure they cannot act on — and the degradation is already safe: an unbound device
 * simply gets challenged when it does something sensitive. So failures are recorded in
 * state for a debug surface and never surfaced as an alert.
 *
 * ## Why it does not auto-answer its own challenge
 *
 * It cannot. The challenge is an SMS code, and the app has no way to read it. So the bind
 * completes in two phases: this hook starts it and hands the challenge to the caller, which
 * decides where to prompt. On first sign-in that is the onboarding screen; a user who
 * dismisses it stays unbound and is challenged later instead — which is a worse experience,
 * not a broken one.
 */

export type BindState =
  /** Not started — no session yet, or already known bound. */
  | { phase: 'idle' }
  | { phase: 'binding' }
  /** A challenge is outstanding. The caller must prompt for it. */
  | { phase: 'challenge'; challenge: StepUpChallenge; deviceRef: string }
  | { phase: 'bound'; deviceRef: string }
  | { phase: 'failed'; reason: string };

export function useDeviceBinding(enabled: boolean) {
  const [state, setState] = useState<BindState>({ phase: 'idle' });
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const alive = useRef(true);
  /**
   * Guards against a second bind in one session.
   *
   * `enabled` flips when auth resolves, and React 19's effects can run twice in
   * development — two concurrent binds would both be idempotent server-side, but the
   * second would EXPIRE the first's challenge (one live challenge per action, by design),
   * so the code the user just received would stop working. The ref makes that impossible.
   */
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The local device id is needed by screens regardless of bind outcome, so it is
  // resolved independently of the bind attempt.
  useEffect(() => {
    void (async () => {
      const id = await resolveDeviceId();
      if (alive.current) setDeviceId(id);
    })();
  }, []);

  const bind = useCallback(async (options: { force?: boolean } = {}) => {
    /**
     * Respect a previous "Not now" before touching the network.
     *
     * Checked here rather than in the component so the request is not made at all — issuing a
     * challenge the user will never see burns a real Twilio verification and an SMS, and it
     * would EXPIRE any challenge they were legitimately part-way through.
     *
     * `force` is how the security screen can bind on demand, which is the escape hatch that
     * makes snoozing safe: the user is never locked out of registering.
     */
    if (!options.force && (await isDeviceBindSnoozed())) {
      setState({ phase: 'idle' });
      return;
    }

    setState({ phase: 'binding' });
    try {
      const context = await readDeviceContext();
      const ticket = await deviceService.begin(context);
      if (!alive.current) return;

      if (ticket.stepUp === null) {
        // Already ACTIVE. The ordinary path on every launch after the first.
        setState({ phase: 'bound', deviceRef: ticket.deviceRef });
        return;
      }

      setState({
        phase: 'challenge',
        challenge: ticket.stepUp,
        deviceRef: ticket.deviceRef,
      });
    } catch (caught) {
      if (!alive.current) return;
      /**
       * Held in state, not thrown and not toasted.
       *
       * The most common cause is a user who is not KYC-verified yet, or an offline launch.
       * Neither is something to interrupt somebody about, and neither leaves the app less
       * safe — an unbound device is scored as unbound.
       */
      setState({
        phase: 'failed',
        reason:
          caught instanceof Error
            ? caught.message
            : 'Could not register this device.',
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void bind();
  }, [enabled, bind]);

  /**
   * Answer the bind challenge.
   *
   * Returns a boolean rather than throwing, because the caller is a prompt that needs to
   * distinguish "wrong code, let them retry" from "done" — and an exception at that
   * boundary would have to be caught and converted anyway.
   */
  const confirm = useCallback(
    async (answer: string): Promise<{ ok: boolean; error?: string }> => {
      if (state.phase !== 'challenge') {
        return { ok: false, error: 'There is nothing to confirm.' };
      }
      try {
        await deviceService.confirm(state.challenge.nonce, answer);
        // The device is bound, so any earlier snooze is moot. Cleared so a later re-bind
        // (after a revoke, say) is not silently suppressed by a stale timestamp.
        await clearDeviceBindSnooze();
        if (alive.current) {
          setState({ phase: 'bound', deviceRef: state.deviceRef });
        }
        return { ok: true };
      } catch (caught) {
        return {
          ok: false,
          error:
            caught instanceof Error
              ? caught.message
              : 'That code was not correct.',
        };
      }
    },
    [state],
  );

  /**
   * Give up on the challenge without binding.
   *
   * Records a snooze, so the answer means something. Without it the prompt returns on the very
   * next launch and "Not now" is a button that does nothing — which is worse than not
   * offering it. The device stays unbound and is challenged on large payments instead, which
   * is the honest cost stated in the sheet's own copy.
   */
  const dismiss = useCallback(() => {
    void snoozeDeviceBind();
    setState({ phase: 'idle' });
  }, []);

  return {
    state,
    deviceId,
    confirm,
    dismiss,
    /** Bind on demand, ignoring any snooze. The escape hatch that makes snoozing safe. */
    retry: () => bind({ force: true }),
  };
}
