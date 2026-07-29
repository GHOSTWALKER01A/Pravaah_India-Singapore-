import { useEffect, useRef, useState } from 'react';

import { paymentsService } from '@/api/payments/services';
import type { QuoteRequest, QuoteView } from '@/api/payments/schemas';

/**
 * A locked price, with the clock that governs it.
 *
 * The interesting part is the countdown, and specifically that it is driven from a DEADLINE
 * rather than a decrementing counter. Two things make the naive version wrong:
 *
 * 1. **A JS interval is not a clock.** It drifts, and it stops entirely while the app is
 *    backgrounded. A user who switches away for two minutes and returns would see a quote with
 *    40 seconds still on it — and a submit that fails with "that price has expired", which
 *    reads as a bug rather than as the rate lock working.
 * 2. **The device clock may be wrong.** So the deadline is computed from the server's
 *    `validForMs` at the moment of arrival, not from parsing `validUntil` against `Date.now()`.
 *    A phone an hour behind would otherwise think every quote was still fresh.
 *
 * When it does expire the quote is NOT cleared — `expired` goes true and the numbers stay on
 * screen. Blanking them would leave the user staring at an empty confirmation screen with no
 * idea what they had been about to pay.
 */
export function useQuote() {
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);

  /** Monotonic-ish deadline, set from the server's duration when the quote lands. */
  const deadline = useRef<number | null>(null);
  const alive = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const request = async (input: QuoteRequest) => {
    // Every request gets a sequence number, and a late response from a superseded one is
    // dropped. Without this, a user editing the amount quickly can have an OLD quote arrive
    // last and win — pricing their transfer at a figure they have already changed.
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await paymentsService.quote(input);
      if (!alive.current || id !== requestId.current) return null;
      setQuote(next);
      deadline.current = Date.now() + next.validForMs;
      setRemainingMs(next.validForMs);
      return next;
    } catch (caught) {
      if (!alive.current || id !== requestId.current) return null;
      setError(
        caught instanceof Error ? caught.message : 'Could not price that transfer.',
      );
      setQuote(null);
      deadline.current = null;
      setRemainingMs(0);
      return null;
    } finally {
      if (alive.current && id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!quote || deadline.current === null) return;

    const tick = () => {
      if (deadline.current === null) return;
      // Recomputed from the deadline on every tick, so a missed interval (background, a slow
      // frame) self-corrects instead of accumulating drift.
      const left = deadline.current - Date.now();
      setRemainingMs(left > 0 ? left : 0);
    };

    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [quote]);

  const clear = () => {
    requestId.current += 1;
    setQuote(null);
    setError(null);
    deadline.current = null;
    setRemainingMs(0);
  };

  return {
    quote,
    loading,
    error,
    remainingMs,
    /** True once the lock has lapsed. The quote's numbers remain readable. */
    expired: quote !== null && remainingMs <= 0,
    request,
    clear,
  };
}
