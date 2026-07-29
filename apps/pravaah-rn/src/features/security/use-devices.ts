import { useCallback, useEffect, useRef, useState } from 'react';

import { deviceService } from '@/api/security/services';
import type { DeviceView, StepUpChallenge } from '@/api/security/schemas';

/**
 * The device manager's data — the self-service ATO defence.
 *
 * ## Why this is the most valuable screen in M6
 *
 * The account holder notices a device they do not recognise before any model does. A user
 * who can revoke it in one tap has stopped a takeover; a user who has to contact support
 * has lost the window in which stopping it was cheap. So the list is a read, and the revoke
 * is a single unconfirmed action.
 *
 * ## Why revoke is optimistic and recover is not
 *
 * Revoking is the SAFE direction and it always succeeds for a device the user owns, so the
 * row is removed locally the moment they tap — waiting on a round trip to acknowledge "yes,
 * that phone is gone" adds anxiety to the one action that should feel instant. If the call
 * then fails, the list is refetched and the row returns, with the error stated.
 *
 * Recovery is the opposite: it needs a challenge, it can fail on a wrong code, and getting
 * it wrong leaves a device frozen. Nothing about it is optimistic.
 */
export function useDevices() {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await deviceService.list();
      if (!alive.current) return;
      setDevices(next);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not load your devices.',
      );
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (deviceRef: string): Promise<{ ok: boolean; error?: string }> => {
      setBusyId(deviceRef);
      // Optimistic: the row goes now. See the note above on why only this action is.
      const previous = devices;
      setDevices((current) => current.filter((row) => row.id !== deviceRef));

      try {
        await deviceService.revoke(deviceRef);
        return { ok: true };
      } catch (caught) {
        if (alive.current) {
          // Put it back. A device the user believes is gone but is not would be the worst
          // possible outcome of this screen.
          setDevices(previous);
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not remove that device.',
          );
        }
        return {
          ok: false,
          error: caught instanceof Error ? caught.message : undefined,
        };
      } finally {
        if (alive.current) setBusyId(null);
      }
    },
    [devices],
  );

  /** Ask for the challenge that unfreezes a swap-suspected device. */
  const requestRecovery = useCallback(
    async (
      deviceRef: string,
    ): Promise<{ challenge?: StepUpChallenge; error?: string }> => {
      setBusyId(deviceRef);
      try {
        const challenge = await deviceService.requestRecovery(deviceRef);
        return { challenge };
      } catch (caught) {
        return {
          error:
            caught instanceof Error
              ? caught.message
              : 'Could not start verification.',
        };
      } finally {
        if (alive.current) setBusyId(null);
      }
    },
    [],
  );

  const recover = useCallback(
    async (
      deviceRef: string,
      nonce: string,
      answer: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      setBusyId(deviceRef);
      try {
        await deviceService.recover(deviceRef, { nonce, answer });
        // Refetched rather than patched locally: recovery also resets the cooling-off
        // window, and reproducing that arithmetic client-side is how the two drift apart.
        await load();
        return { ok: true };
      } catch (caught) {
        return {
          ok: false,
          error:
            caught instanceof Error
              ? caught.message
              : 'That code was not correct.',
        };
      } finally {
        if (alive.current) setBusyId(null);
      }
    },
    [load],
  );

  return {
    devices,
    loading,
    error,
    busyId,
    refresh: load,
    revoke,
    requestRecovery,
    recover,
  };
}
