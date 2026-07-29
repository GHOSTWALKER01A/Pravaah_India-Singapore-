import { useCallback, useEffect, useRef, useState } from 'react';

import { beneficiaryService } from '@/api/payments/services';
import type {
  AddBeneficiaryRequest,
  BeneficiaryView,
  ResolvedPayee,
} from '@/api/payments/schemas';

/** The payee book. */
export function usePayees(options: { search?: string } = {}) {
  const { search } = options;

  const [payees, setPayees] = useState<BeneficiaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const page = await beneficiaryService.list({ search, limit: 100 });
      if (!alive.current) return;
      setPayees(page.items);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      setError(caught instanceof Error ? caught.message : 'Could not load your payees.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  return { payees, loading, error, refresh: load };
}

/**
 * Resolve a typed UPI ID to the name its bank holds.
 *
 * Debounced, and the debounce is not a performance nicety: every keystroke would otherwise be a
 * lookup of somebody's banking details, and the intermediate strings are other people's real
 * addresses. `ravi@ybl` is a valid VPA on the way to typing `ravi.kumar@ybl`.
 *
 * The stale-response guard matters for the same reason as on the quote: a slow lookup of a
 * half-typed address must never land after a newer one and show the user a name belonging to
 * an address they are no longer paying.
 */
export function useResolvePayee(options: { debounceMs?: number } = {}) {
  const { debounceMs = 500 } = options;

  const [resolved, setResolved] = useState<ResolvedPayee | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    sequence.current += 1;
    setResolved(null);
    setResolving(false);
    setError(null);
  };

  /**
   * Look up a VPA. Only ever called with something that already looks addressable —
   * the screen gates on a client-side shape check first, so a user typing `r` does not
   * trigger a lookup, and the server is not asked about strings nobody could pay.
   */
  const resolve = (vpa: string) => {
    if (timer.current) clearTimeout(timer.current);
    const id = ++sequence.current;
    setResolving(true);
    setError(null);

    timer.current = setTimeout(async () => {
      try {
        const next = await beneficiaryService.resolve(vpa);
        if (!alive.current || id !== sequence.current) return;
        setResolved(next);
      } catch (caught) {
        if (!alive.current || id !== sequence.current) return;
        setResolved(null);
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not check that UPI ID. Try again.',
        );
      } finally {
        if (alive.current && id === sequence.current) setResolving(false);
      }
    }, debounceMs);
  };

  return { resolved, resolving, error, resolve, clear };
}

/** Add a payee. Returns the created row so the caller can go straight to paying them. */
export function useAddPayee() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const add = async (request: AddBeneficiaryRequest): Promise<BeneficiaryView | null> => {
    // A double-tap on "Add" would otherwise create the payee twice. The server dedupes on
    // (user, handle) so the second would be harmless — but it would also return a different
    // row shape than the caller expects, and the guard is one line.
    if (inFlight.current) return null;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      return await beneficiaryService.add(request);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that payee.');
      return null;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return { add, saving, error };
}
