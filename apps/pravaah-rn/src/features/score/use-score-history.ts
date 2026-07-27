import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, scoreService, type ScoreHistoryEntry } from '@/api';

interface UseScoreHistory {
  history: ScoreHistoryEntry[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Score history. No polling: history only changes when the user recomputes, and
 * that path already refreshes on focus.
 */
export function useScoreHistory(limit = 12): UseScoreHistory {
  const [history, setHistory] = useState<ScoreHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await scoreService.history(limit);
      if (mounted.current) setHistory(rows);
    } catch (err) {
      if (mounted.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load your score history.',
        );
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load();
  }, [load]);

  return { history, loading, error, refetch: load };
}
