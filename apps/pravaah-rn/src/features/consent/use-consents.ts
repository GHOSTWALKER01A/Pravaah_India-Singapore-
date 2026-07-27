import { useCallback, useEffect, useState } from 'react';

import { ApiError, consentService, type ConsentSummary } from '@/api';

interface UseConsents {
  consents: ConsentSummary[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/** Loads the caller's consent dashboard list. */
export function useConsents(): UseConsents {
  const [consents, setConsents] = useState<ConsentSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setConsents(await consentService.list());
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load your consents.',
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return {
    consents,
    loading,
    error,
    refetch: useCallback(() => load(false), [load]),
  };
}
