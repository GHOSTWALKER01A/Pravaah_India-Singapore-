import { useCallback, useEffect, useState } from 'react';

import { ApiError, sharesService } from '@/api';
import type { ShareReceiptDetail, WithdrawShareResult } from '@/api';

interface UseShareReceipt {
  receipt: ShareReceiptDetail | null;
  loading: boolean;
  /** The receipt does not exist, or belongs to another account. The server does not say which. */
  notFound: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  withdrawing: boolean;
  withdrawError: string | null;
  /** Resolves to the result on success, null on failure (the error is in `withdrawError`). */
  withdraw: () => Promise<WithdrawShareResult | null>;
}

/**
 * One consent receipt, and the holder's withdrawal of it.
 *
 * After a withdrawal the receipt is RE-FETCHED rather than patched locally. The server's
 * answer is the record — status, withdrawal time, whether its copy is already redacted —
 * and a locally-assembled "WITHDRAWN" could disagree with it on the one screen where the
 * holder needs to know exactly what state their data is in.
 */
export function useShareReceipt(receiptId: string): UseShareReceipt {
  const [receipt, setReceipt] = useState<ShareReceiptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReceipt(await sharesService.detail(receiptId));
      setNotFound(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setNotFound(true);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Could not load this receipt.');
      }
    } finally {
      setLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const withdraw = useCallback(async () => {
    setWithdrawing(true);
    setWithdrawError(null);
    try {
      const result = await sharesService.withdraw(receiptId);
      await load();
      return result;
    } catch (caught) {
      // A 409 means it is ALREADY withdrawn or expired — the end state the holder wanted.
      // Re-read and show the real state rather than presenting success as a failure.
      if (caught instanceof ApiError && caught.status === 409) {
        await load();
        return null;
      }
      setWithdrawError(
        `${
          caught instanceof ApiError ? caught.message : 'The withdrawal did not go through.'
        } Nothing changed — the organisation still has what you shared, and this share is still active. Try again.`,
      );
      return null;
    } finally {
      setWithdrawing(false);
    }
  }, [load, receiptId]);

  return {
    receipt,
    loading,
    notFound,
    error,
    refetch: load,
    withdrawing,
    withdrawError,
    withdraw,
  };
}
