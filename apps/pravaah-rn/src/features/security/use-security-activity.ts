import { useCallback, useEffect, useRef, useState } from 'react';

import { securityService } from '@/api/security/services';
import type { HoldView, SecurityActivityView } from '@/api/security/schemas';

/**
 * The two transparency views — my decisions, and what of mine is held.
 *
 * ## Why they load together
 *
 * They are shown on one screen and answer one question in two tenses: what has happened to
 * me, and what is happening now. Two hooks would mean two loading states and two error
 * states on a screen that has one purpose, and a user watching half of it populate.
 *
 * ## Why holds are polled and activity is not
 *
 * A hold RESOLVES while the user is looking at it — an analyst clears it and the payment
 * goes through, which is exactly the moment the screen most needs to be right. Activity is
 * a history; it changes only when the user does something, at which point they are not on
 * this screen.
 *
 * The interval is slow on purpose. This is not a payment in flight (which
 * `useTransfer` backs off from 1.5s); it is a queue with a four-hour SLA, so asking every
 * twenty seconds is already far more often than the answer can change.
 */
const HOLD_POLL_MS = 20_000;

export function useSecurityActivity(options: { pollHolds?: boolean } = {}) {
  const { pollHolds = true } = options;

  const [activity, setActivity] = useState<SecurityActivityView[]>([]);
  const [holds, setHolds] = useState<HoldView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      /**
       * Both in one round of concurrency, and a partial failure is tolerated.
       *
       * `allSettled`, not `all`: the holds endpoint failing must not blank the activity
       * list. On a security screen, replacing what a user can see with an error because the
       * OTHER half timed out is the least helpful possible response — they came here
       * because something worried them.
       */
      const [activityResult, holdsResult] = await Promise.allSettled([
        securityService.activity(),
        securityService.holds(),
      ]);
      if (!alive.current) return;

      if (activityResult.status === 'fulfilled') {
        setActivity(activityResult.value);
      }
      if (holdsResult.status === 'fulfilled') {
        setHolds(holdsResult.value);
      }

      const bothFailed =
        activityResult.status === 'rejected' && holdsResult.status === 'rejected';
      setError(
        bothFailed ? 'Could not load your security activity.' : null,
      );
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Refresh only the holds, for the poll — activity does not change on its own. */
  const refreshHolds = useCallback(async () => {
    try {
      const next = await securityService.holds();
      if (alive.current) setHolds(next);
    } catch {
      // A failed poll keeps the last known holds. Blanking them mid-review would read as
      // "your payment is no longer held", which is a claim we cannot make from a timeout.
    }
  }, []);

  useEffect(() => {
    if (!pollHolds) return;
    // Nothing held means nothing to watch. The poll starts when there is, and stops when
    // the last hold resolves — so an ordinary user's screen makes no repeat requests at all.
    if (holds.length === 0) return;

    const schedule = () => {
      timer.current = setTimeout(async () => {
        await refreshHolds();
        if (alive.current) schedule();
      }, HOLD_POLL_MS);
    };

    schedule();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pollHolds, holds.length, refreshHolds]);

  return { activity, holds, loading, error, refresh: load };
}
