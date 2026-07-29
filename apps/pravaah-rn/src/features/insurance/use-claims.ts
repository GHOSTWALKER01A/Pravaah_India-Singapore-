import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/api';
import { claimsService, type ClaimUpload } from '@/api/insurance/services';
import type { Claim } from '@/api/insurance/schemas';

/**
 * The claims hooks.
 *
 * Same conventions as `use-insurance.ts`, and for the same React Compiler reasons: the `alive`
 * ref is declared inline in each hook rather than shared through a helper, and callbacks are
 * hoisted to consts before the return. See the note at the top of that file.
 */

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/* ────────────────────────────────────────────────────────────────────────────
   The claims list
   ──────────────────────────────────────────────────────────────────────────── */

export function useClaims(policyId?: string) {
  const [claims, setClaims] = useState<Claim[]>([]);
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
        const result = await claimsService.claims({
          limit: 50,
          ...(policyId ? { policyId } : {}),
        });
        if (alive.current) setClaims(result.items);
      } catch (err) {
        if (alive.current) {
          setError(messageFrom(err, 'Could not load your claims.'));
        }
      } finally {
        if (alive.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [policyId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  /** Claims still moving. Drives the count on the Cover tab. */
  const open = claims.filter((claim) => !claim.isFinal);

  const refresh = useCallback(() => load(true), [load]);
  const reload = useCallback(() => load(false), [load]);

  return { claims, open, loading, refreshing, error, refresh, reload };
}

/* ────────────────────────────────────────────────────────────────────────────
   One claim
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * One claim, polling while it is in flight.
 *
 * This polls where `usePolicy` mostly does not, and the exception is deliberate. A claim has
 * two states that resolve on OUR side within seconds of the claimant acting: the fraud gate
 * running after `finalise`, and the M4 payout settling after an approval. Both are moments the
 * claimant is holding the phone waiting — somebody just told "approved" watches for the money
 * — so a poll here buys a real answer rather than burning battery on a state a human has to
 * move.
 *
 * It stops on `isFinal`, which the SERVER computes. Note that `APPROVED` is NOT final: the
 * claimant has been promised money that has not arrived, and stopping there would leave them
 * looking at "approved" with no idea when it becomes cash.
 */
export function useClaim(claimId: string, pollMs = 3000) {
  const [claim, setClaim] = useState<Claim | null>(null);
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
        const row = await claimsService.claim(claimId);
        if (alive.current) {
          setClaim(row);
          setError(null);
        }
      } catch (err) {
        if (alive.current) {
          setError(messageFrom(err, 'Could not load this claim.'));
        }
      } finally {
        if (alive.current && !silent) setLoading(false);
      }
    },
    [claimId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const inFlight = claim !== null && !claim.isFinal;

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void load(true), pollMs);
    return () => clearInterval(timer);
  }, [inFlight, pollMs, load]);

  const refresh = useCallback(() => load(true), [load]);

  /**
   * Replace the local copy after a mutation, without a round trip.
   *
   * Every claim mutation returns the updated claim, so re-fetching would be a second request
   * for something already in hand — and worse, a visible flicker on a screen the claimant is
   * watching for a status change.
   */
  const apply = useCallback((next: Claim) => {
    if (alive.current) setClaim(next);
  }, []);

  return { claim, loading, error, refresh, apply };
}

/* ────────────────────────────────────────────────────────────────────────────
   Uploading evidence
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Attach documents, one at a time.
 *
 * ONE AT A TIME rather than in parallel, and that is the important decision. The claimant this
 * serves is on a phone in a hospital corridor on a patchy connection: three concurrent
 * multipart uploads contend for the same thin pipe, all three slow down, and a timeout loses
 * all three. Sequential uploads mean a failure costs one photograph and the two that already
 * landed are still attached to the claim.
 */
export function useClaimUploads(claimId: string) {
  const [uploading, setUploading] = useState(false);
  const [pendingDocType, setPendingDocType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const upload = useCallback(
    async (docType: string, file: ClaimUpload): Promise<Claim | null> => {
      setUploading(true);
      setPendingDocType(docType);
      setError(null);
      try {
        const updated = await claimsService.addDocument(claimId, docType, file);
        return updated;
      } catch (err) {
        if (alive.current) {
          setError(
            messageFrom(
              err,
              'That document could not be sent. Check your connection and try again.',
            ),
          );
        }
        return null;
      } finally {
        if (alive.current) {
          setUploading(false);
          setPendingDocType(null);
        }
      }
    },
    [claimId],
  );

  const clearError = useCallback(() => setError(null), []);

  return { uploading, pendingDocType, error, upload, clearError };
}
