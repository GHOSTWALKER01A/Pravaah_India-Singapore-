import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/api';
import { insuranceService } from '@/api/insurance/services';
import type { InsuranceQuote } from '@/api/insurance/schemas';

/**
 * One quote, loaded by id.
 *
 * ## Why this never polls
 *
 * A quote is FROZEN by construction. It is an underwriting decision taken at a moment and
 * held for thirty minutes precisely so the holder is sold the cover they were shown, at the
 * price they were shown, on the evidence that produced it. Polling would either return the
 * identical row forever or — worse, if the server ever re-priced on read — change a figure
 * under somebody's finger while they were deciding whether to accept it.
 *
 * The expiry is handled by the SERVER's own `isBuyable`, read once. A client-side countdown
 * that flipped the button to disabled at the 30-minute mark would be racing a clock it does
 * not own, and would refuse a purchase the server would still have honoured.
 */
export function useQuote(quoteId: string) {
  const [quote, setQuote] = useState<InsuranceQuote | null>(null);
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
      const row = await insuranceService.getQuote(quoteId);
      if (mounted.current) setQuote(row);
    } catch (err) {
      if (mounted.current) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load this price. Ask for a new one.',
        );
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { quote, loading, error, refetch: load };
}
