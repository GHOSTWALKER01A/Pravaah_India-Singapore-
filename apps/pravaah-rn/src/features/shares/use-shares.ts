import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, sharesService } from '@/api';
import type { ShareReceipt, ShareReceiptStatus } from '@/api';

export type ShareFilter = ShareReceiptStatus | 'ALL';

const PAGE = 20;

interface UseShares {
  items: ShareReceipt[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * The holder's consent receipts, filtered and paged.
 *
 * Every response is tagged with the request that produced it, and a response for a
 * superseded filter is dropped. Without that, tapping "Active" then "Withdrawn" quickly
 * lets the slower first answer land last — and the holder reads a list of active shares
 * under a "Withdrawn" heading, which on this screen is exactly the wrong lie to tell.
 */
export function useShares(filter: ShareFilter): UseShares {
  const [items, setItems] = useState<ShareReceipt[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const status = filter === 'ALL' ? undefined : filter;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await sharesService.list({ status, limit: PAGE, offset: 0 });
      if (mine !== generation.current) return;
      setItems(page.items);
      setTotal(page.total);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof ApiError ? caught.message : 'Could not load your shares.');
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [status]);

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= total) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await sharesService.list({ status, limit: PAGE, offset: items.length });
      if (mine !== generation.current) return;
      // De-duplicated by id: a share issued between two pages shifts the offset window,
      // and the same receipt would otherwise render twice.
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(page.total);
    } catch (caught) {
      if (mine !== generation.current) return;
      setError(caught instanceof ApiError ? caught.message : 'Could not load more shares.');
    } finally {
      setLoadingMore(false);
    }
  }, [items.length, loadingMore, status, total]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    items,
    total,
    hasMore: items.length < total,
    loading,
    loadingMore,
    error,
    refetch: load,
    loadMore,
  };
}
