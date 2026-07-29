import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  scoreService,
  type FairnessConsentRequest,
  type FairnessConsentStatus,
} from '@/api';

interface UseFairnessConsent {
  status: FairnessConsentStatus | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (request: FairnessConsentRequest) => Promise<boolean>;
  refetch: () => Promise<void>;
}

/**
 * The separate consent for audit-only protected attributes.
 *
 * The backend never returns the stored VALUES — only which attributes are held —
 * so this hook cannot pre-fill the form from the server. That is deliberate: the
 * app has no reason to read someone's gender back out, and every reason not to.
 * The form therefore starts empty on each visit, and re-granting means re-stating.
 */
export function useFairnessConsent(): UseFairnessConsent {
  const [status, setStatus] = useState<FairnessConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      const res = await scoreService.fairnessConsent();
      if (mounted.current) setStatus(res);
    } catch (err) {
      if (mounted.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load your fairness-consent status.',
        );
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (request: FairnessConsentRequest) => {
    setSaving(true);
    setError(null);
    try {
      await scoreService.setFairnessConsent(request);
      await load();
      return true;
    } catch (err) {
      if (mounted.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not save your choice. Please try again.',
        );
      }
      return false;
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return { status, loading, saving, error, save, refetch: load };
}
