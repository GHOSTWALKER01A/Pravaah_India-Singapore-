import { useCallback, useEffect, useRef, useState } from 'react';

import { transferService } from '@/api/payments/services';
import type { ReceiptView, TransactionView } from '@/api/payments/schemas';

import { txnStatus } from './meta';

/**
 * Track one payment to its conclusion.
 *
 * The polling policy is the whole content of this hook, and every part of it is a decision:
 *
 * - **We poll OUR API, never the rail.** Only the backend knows what a rail answer MEANS —
 *   whether a FAILED is terminal, retryable, or actually a timeout that must not release the
 *   reserve. A client asking the rail directly would show a user "failed" for a payment that
 *   settles a minute later.
 * - **The server's `isFinal` decides when to stop**, with the local status table as a fallback.
 *   A client that owned that judgement would need the fourteen-state machine duplicated here
 *   and kept in sync forever.
 * - **The interval backs off.** A UPI payment that is going to settle usually settles in
 *   seconds, so the first few checks are fast; after that the gaps widen, because a transfer
 *   still pending at 30 seconds is waiting on a bank and hammering it changes nothing.
 * - **Polling stops when the screen is not mounted.** No background timers surviving a
 *   navigation — the reconciler on the server is what guarantees the outcome is recorded, not
 *   this hook staying alive.
 *
 * DEEMED is deliberately treated as final for polling purposes even though the transaction is
 * unresolved: the rail has stopped answering and a human is now involved, so continuing to ask
 * would spend battery to learn nothing. The screen says so in words instead.
 */
const BACKOFF_MS = [1_500, 1_500, 2_000, 3_000, 5_000, 8_000, 12_000] as const;

export function useTransfer(
  transactionId: string | null,
  options: { initial?: TransactionView | null; poll?: boolean } = {},
) {
  const { initial = null, poll = true } = options;

  const [transaction, setTransaction] = useState<TransactionView | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const isFinal = useCallback((next: TransactionView | null): boolean => {
    if (!next) return false;
    // The server's own judgement first; the local table only as a fallback for a response shape
    // that predates the field.
    if (typeof next.isFinal === 'boolean') return next.isFinal;
    return !txnStatus(next.status).inFlight;
  }, []);

  const fetchOnce = useCallback(async () => {
    if (!transactionId) return null;
    try {
      const next = await transferService.detail(transactionId);
      if (!alive.current) return null;
      setTransaction(next);
      setError(null);
      return next;
    } catch (caught) {
      if (!alive.current) return null;
      // A failed poll must NOT blank the transaction. The user is watching a payment; replacing
      // its state with an error because one request timed out is the worst possible moment to
      // lose the thread.
      setError(
        caught instanceof Error ? caught.message : 'Could not check this payment.',
      );
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => {
    if (!transactionId) return;
    // An initial value from the create response means the first fetch can be skipped — the
    // server already told us the state, and re-asking immediately just adds a round trip to the
    // most latency-sensitive screen in the app.
    if (initial === null) void fetchOnce();
  }, [transactionId, initial, fetchOnce]);

  useEffect(() => {
    if (!poll || !transactionId) return;
    if (isFinal(transaction)) return;

    const schedule = () => {
      const delay =
        BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)] ?? 12_000;
      timer.current = setTimeout(async () => {
        attempt.current += 1;
        const next = await fetchOnce();
        if (!alive.current) return;
        if (!isFinal(next)) schedule();
      }, delay);
    };

    schedule();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `transaction` is a dependency on purpose: each state change re-evaluates whether to keep
    // polling, which is how the loop terminates the moment the payment settles.
  }, [poll, transactionId, transaction, fetchOnce, isFinal]);

  return {
    transaction,
    loading,
    error,
    settled: isFinal(transaction),
    refresh: fetchOnce,
  };
}

/**
 * The counterfoil — a payment plus the user's own ledger movements and any refunds.
 *
 * Separate from `useTransfer` because it is a heavier call and only the receipt screen needs it;
 * putting the movements on the polling path would re-fetch the whole ledger every 1.5 seconds
 * while a payment clears.
 */
export function useReceipt(transactionId: string | null) {
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
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
    if (!transactionId) return;
    try {
      const next = await transferService.receipt(transactionId);
      if (!alive.current) return;
      setReceipt(next);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      setError(
        caught instanceof Error ? caught.message : 'Could not load this receipt.',
      );
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { receipt, loading, error, refresh: load };
}
