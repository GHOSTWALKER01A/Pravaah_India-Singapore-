import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, isComputedScore, scoreService, type ScoreResult } from '@/api';

interface UseScore {
  score: ScoreResult | null;
  loading: boolean;
  /** True while a POST /score/compute is in flight. */
  computing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  compute: () => Promise<void>;
}

/**
 * Loads the reputation score and polls while it is still being worked out.
 *
 * Polling stops the moment the state settles, which matters more here than in M1:
 * `GET /score` is cheap and never triggers inference, but a poll that never stops
 * would keep a phone awake indefinitely on a state that will not change without
 * the user doing something (NO_CONSENT, INSUFFICIENT_DATA, EXPIRED).
 */
export function useScore(pollMs = 2500): UseScore {
  const [score, setScore] = useState<ScoreResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a late response from a superseded request overwriting a newer
  // one — the compute and the poll can be in flight at the same time.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const result = await scoreService.current();
      if (mounted.current) setScore(result);
    } catch (err) {
      if (mounted.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load your reputation score.',
        );
      }
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const compute = async () => {
    setComputing(true);
    setError(null);
    try {
      const result = await scoreService.compute();
      if (mounted.current) setScore(result);
    } catch (err) {
      if (mounted.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not compute your score right now.',
        );
      }
    } finally {
      if (mounted.current) setComputing(false);
    }
  };

  // Only PENDING is genuinely transient. Everything else waits on the user.
  const isPending = score?.state === 'PENDING';

  useEffect(() => {
    if (!isPending) return;
    const timer = setInterval(() => void load(true), pollMs);
    return () => clearInterval(timer);
  }, [isPending, pollMs, load]);

  return {
    score,
    loading,
    computing,
    error,
    refetch: useCallback(() => load(false), [load]),
    compute,
  };
}

/** Convenience: the computed score, or null in any other state. */
export function computedOrNull(score: ScoreResult | null) {
  return score && isComputedScore(score) ? score : null;
}
