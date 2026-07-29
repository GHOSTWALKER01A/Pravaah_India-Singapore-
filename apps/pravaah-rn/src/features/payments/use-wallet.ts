import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/api/core/error.types';
import { paymentsService, transferService } from '@/api/payments/services';
import type {
  StatementEntry,
  TransactionView,
  WalletView,
} from '@/api/payments/schemas';

/**
 * The current leaf of the cheque book: balance, caps, UPI IDs, and the recent counterfoils.
 *
 * One hook rather than three, because the Pay tab needs all of it at once and three
 * independently-loading regions would make the screen assemble itself in front of the user.
 * The wallet is the slow call; the recent list is fetched alongside it and is allowed to fail
 * without blanking the balance — a payment history that will not load is an inconvenience, a
 * balance that will not load is a user who cannot tell whether their money is there.
 */
export function useWallet(options: { recentLimit?: number } = {}) {
  const { recentLimit = 6 } = options;

  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [recent, setRecent] = useState<TransactionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      try {
        const [next, history] = await Promise.all([
          paymentsService.wallet(),
          transferService.list({ limit: recentLimit }).catch(() => null),
        ]);
        if (!alive.current) return;
        setWallet(next);
        if (history) setRecent(history.items);
        setError(null);
      } catch (caught) {
        if (!alive.current) return;
        setError(
          caught instanceof ApiError || caught instanceof Error
            ? caught.message
            : 'Could not load your wallet.',
        );
      } finally {
        if (alive.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [recentLimit],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  /**
   * KEPT deliberately, and it must stay — see `refetch` in `use-kyc-status.ts` for the full
   * reasoning. `pay-screen.tsx` names this in a `useFocusEffect` dependency array, so an
   * unstable identity would re-fetch the wallet on every render of the Pay tab.
   */
  const refresh = useCallback(() => load('refresh'), [load]);

  return { wallet, recent, loading, refreshing, error, refresh };
}

/**
 * The passbook — every ledger movement, paged.
 *
 * Built from ledger ENTRIES, not transactions, and that is the point of having it as well as a
 * payment list: a transaction says what the user tried to do, the ledger says what happened to
 * their money. When somebody disputes a balance, this is the document that answers them.
 */
export function useStatement(options: { currency?: string; pageSize?: number } = {}) {
  const { currency, pageSize = 40 } = options;

  const [entries, setEntries] = useState<StatementEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  // Guards a double-fire from a fast scroll reaching the end threshold twice.
  const fetching = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (offset: number) => {
      if (fetching.current) return;
      fetching.current = true;
      if (offset > 0) setLoadingMore(true);
      try {
        const page = await paymentsService.statement({
          currency,
          limit: pageSize,
          offset,
        });
        if (!alive.current) return;
        // Replace on the first page, append after — so a pull-to-refresh cannot duplicate rows.
        setEntries((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        setError(null);
      } catch (caught) {
        if (!alive.current) return;
        setError(
          caught instanceof Error ? caught.message : 'Could not load your statement.',
        );
      } finally {
        fetching.current = false;
        if (alive.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [currency, pageSize],
  );

  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage]);

  const loadMore = () => {
    if (entries.length >= total) return;
    void fetchPage(entries.length);
  };

  return {
    entries,
    total,
    loading,
    loadingMore,
    error,
    hasMore: entries.length < total,
    loadMore,
    refresh: () => fetchPage(0),
  };
}
