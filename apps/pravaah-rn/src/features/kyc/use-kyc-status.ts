import { useCallback, useEffect, useState } from 'react';

import { ApiError, kycService, type KycProfileStatus } from '@/api';

interface UseKycStatusOptions {
  /**
   * When set, the status is re-fetched on this interval (ms) as long as it is
   * NOT terminal — so an admin approval/rejection appears on the device within
   * one interval without the user having to leave and re-open the screen.
   * Polling stops automatically once the status is VERIFIED or REJECTED.
   */
  pollMs?: number;
}

interface UseKycStatus {
  status: KycProfileStatus | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/** Terminal states never change again, so there is nothing left to poll for. */
const TERMINAL = new Set<KycProfileStatus['overallStatus']>([
  'VERIFIED',
  'REJECTED',
]);

/** Loads the caller's KYC profile status; polls while pending if `pollMs` set. */
export function useKycStatus(options?: UseKycStatusOptions): UseKycStatus {
  const [status, setStatus] = useState<KycProfileStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `silent` polls don't toggle the loading flag, so background refreshes never
  // flash the full-screen spinner over already-rendered content.
  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setStatus(await kycService.getStatus());
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load your status.',
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const refetch = useCallback(() => load(false), [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const terminal = status ? TERMINAL.has(status.overallStatus) : false;

  useEffect(() => {
    const pollMs = options?.pollMs;
    if (!pollMs || terminal) return;
    const id = setInterval(() => void load(true), pollMs);
    return () => clearInterval(id);
  }, [options?.pollMs, terminal, load]);

  return { status, loading, error, refetch };
}
