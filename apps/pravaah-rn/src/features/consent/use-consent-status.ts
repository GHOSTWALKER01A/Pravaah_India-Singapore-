import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  consentService,
  type ConsentStatusData,
  type ConsentStatusResult,
} from '@/api';

interface UseConsentStatus {
  status: ConsentStatusData | null;
  notFound: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const hasData = (s: ConsentStatusData): boolean =>
  s.dataSession?.status === 'COMPLETED' || s.dataSession?.status === 'PARTIAL';

/**
 * Loads one consent's live status. While the consent is PENDING or its data
 * session is still fetching, it polls on `pollMs` so the "fetching your data…"
 * screen advances to DATA_READY without the user refreshing. Polling stops once
 * the consent is terminal (REVOKED/EXPIRED/REJECTED/FAILED) or data has arrived
 * for a one-time fetch.
 */
export function useConsentStatus(id: string, pollMs = 3000): UseConsentStatus {
  const [status, setStatus] = useState<ConsentStatusData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res: ConsentStatusResult = await consentService.status(id);
        if ('status' in res && res.status === 'NOT_FOUND') {
          setNotFound(true);
          setStatus(null);
        } else {
          setNotFound(false);
          setStatus(res as ConsentStatusData);
        }
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : 'Could not load this consent.',
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Keep polling while the consent is still progressing toward a result.
  const settled =
    !status ||
    status.status === 'REVOKED' ||
    status.status === 'EXPIRED' ||
    status.status === 'REJECTED' ||
    status.status === 'FAILED' ||
    (status.status === 'ACTIVE' && hasData(status));

  useEffect(() => {
    if (settled || notFound) return;
    const t = setInterval(() => void load(true), pollMs);
    return () => clearInterval(t);
  }, [settled, notFound, pollMs, load]);

  return {
    status,
    notFound,
    loading,
    error,
    refetch: useCallback(() => load(false), [load]),
  };
}
