import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/api';
import { insuranceService } from '@/api/insurance/services';
import type {
  InsuranceProduct,
  Policy,
  PremiumPayment,
} from '@/api/insurance/schemas';

/**
 * The insurance data hooks.
 *
 * All five follow the shape `useWallet` and `useScore` established: an `alive` ref so a late
 * response from a superseded request cannot overwrite a newer one, a `silent` reload for
 * polling and pull-to-refresh, and an `ApiError`-aware message.
 *
 * ## Two conventions here are load-bearing rather than stylistic
 *
 * **The `alive` ref is declared inline in each hook, not shared through a helper.** A
 * `useMounted()` helper returning the ref reads better and breaks React Compiler: it cannot
 * reason about a ref that arrived as another hook's return value, so it bails out of the whole
 * hook with "existing memoization could not be preserved" — silently losing auto-memoization
 * for everything in it. `use-wallet.ts` declares its ref inline for the same reason.
 *
 * **Callbacks are hoisted to consts before the return.** A `useCallback` written inside the
 * returned object literal hits the same bail-out.
 *
 * ## Where polling is, and is not
 *
 * Only `usePolicy` polls, and only while a policy is `PENDING_PAYMENT` — the one insurance
 * state that resolves without the user doing anything, and the moment they are watching the
 * screen for. Everything else moves on a human's timescale: a claim is reviewed in hours, a
 * premium falls due in thirty days. Polling those would keep a phone awake for a state that
 * cannot change.
 */

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/* ────────────────────────────────────────────────────────────────────────────
   The marketplace
   ──────────────────────────────────────────────────────────────────────────── */

export function useProducts(currency?: string) {
  const [products, setProducts] = useState<InsuranceProduct[]>([]);
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
    async (silent: boolean) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const rows = await insuranceService.products(
          currency ? { currency } : {},
        );
        if (alive.current) setProducts(rows);
      } catch (err) {
        if (alive.current) {
          setError(messageFrom(err, 'Could not load the cover on offer.'));
        }
      } finally {
        if (alive.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [currency],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { products, loading, refreshing, error, refresh };
}

export function useProduct(productId: string) {
  const [product, setProduct] = useState<InsuranceProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /**
     * A local flag rather than the shared ref.
     *
     * This effect re-runs when `productId` changes, and the flag has to be scoped to THIS
     * run: a mount-scoped ref would let a response for the previous product overwrite the
     * new one, which on a marketplace with three covers is a visible wrong price.
     */
    let live = true;
    setLoading(true);
    insuranceService
      .product(productId)
      .then((row) => {
        if (live) setProduct(row);
      })
      .catch((err: unknown) => {
        if (live) setError(messageFrom(err, 'Could not load this cover.'));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [productId]);

  return { product, loading, error };
}

/* ────────────────────────────────────────────────────────────────────────────
   The policy wallet
   ──────────────────────────────────────────────────────────────────────────── */

export function usePolicies() {
  const [policies, setPolicies] = useState<Policy[]>([]);
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

  const load = useCallback(async (silent: boolean) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      /**
       * Every policy, including lapsed and expired ones.
       *
       * `activeOnly` is deliberately not passed. Hiding a lapsed policy is how somebody
       * discovers they were uninsured at claim time, which is the single worst thing the
       * policy wallet could do to them.
       */
      const result = await insuranceService.policies({ limit: 50 });
      if (alive.current) setPolicies(result.items);
    } catch (err) {
      if (alive.current) {
        setError(messageFrom(err, 'Could not load your policies.'));
      }
    } finally {
      if (alive.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  /** Cover that could be claimed against right now. Drives the claim entry point. */
  const claimable = policies.filter((policy) => policy.isCovered);

  const refresh = useCallback(() => load(true), [load]);
  const reload = useCallback(() => load(false), [load]);

  return { policies, claimable, loading, refreshing, error, refresh, reload };
}

/**
 * One policy, polling only while its premium is still being collected.
 *
 * `PENDING_PAYMENT` is the sole transient state: the premium is settling on the ledger and the
 * flip to ACTIVE is what the holder is watching for. Once it resolves the poll stops, because
 * nothing else about a policy changes on a timescale worth keeping a phone awake for.
 */
export function usePolicy(policyId: string, pollMs = 2500) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const row = await insuranceService.policy(policyId);
        if (alive.current) {
          setPolicy(row);
          setError(null);
        }
      } catch (err) {
        if (alive.current) {
          setError(messageFrom(err, 'Could not load this policy.'));
        }
      } finally {
        if (alive.current && !silent) setLoading(false);
      }
    },
    [policyId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const settling = policy?.status === 'PENDING_PAYMENT';

  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void load(true), pollMs);
    return () => clearInterval(timer);
  }, [settling, pollMs, load]);

  const refresh = useCallback(() => load(true), [load]);

  return { policy, loading, error, refresh };
}

export function usePremiums(policyId: string) {
  const [premiums, setPremiums] = useState<PremiumPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    insuranceService
      .premiums(policyId)
      .then((rows) => {
        if (live) setPremiums(rows);
      })
      .catch((err: unknown) => {
        if (live) {
          setError(messageFrom(err, 'Could not load your premium history.'));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [policyId]);

  return { premiums, loading, error };
}
