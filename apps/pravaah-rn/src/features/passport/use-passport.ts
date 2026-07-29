import { useCallback, useEffect, useRef, useState } from 'react';

import { isActivePassport, passportService } from '@/api';
import type { PendingRequestSummary, WalletResult } from '@/api';

import {
  HolderKeyError,
  ensureHolderKey,
  forgetHolderKey,
  hasHolderKey,
  rememberCredential,
} from './holder-key';

interface UsePassportOptions {
  /** Poll interval while a verifier request could arrive. Off by default. */
  pollMs?: number;
}

/**
 * The wallet's state, plus the actions that need the device key.
 *
 * Issuance lives here rather than in a screen because it is a two-step operation that must
 * not be half-completed: the device key is created FIRST, and only then is its public half
 * sent to be bound into the credential. Getting that order wrong — or letting a screen retry
 * the second half against a regenerated key — would mint a credential bound to a key this
 * device no longer has, which is a passport nobody can ever present.
 */
export function usePassport(options: UsePassportOptions = {}) {
  const { pollMs } = options;

  const [wallet, setWallet] = useState<WalletResult | null>(null);
  const [requests, setRequests] = useState<PendingRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'issue' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The server says this account has a live passport, but THIS device has no key for it.
   *
   * The state a reinstall produces, and it is otherwise undiagnosable: the wallet renders a
   * perfectly valid-looking credential that fails at the first share, in front of a verifier,
   * with an error the user cannot act on. Surfaced as its own flag so the screen can offer the
   * one thing that fixes it — re-issue — instead of letting them discover it at a counter.
   */
  const [keyMissing, setKeyMissing] = useState(false);
  /**
   * Whether the failure is one a retry can fix.
   *
   * A missing native module is a build problem: offering "Try again" for it is a loop the
   * user cannot escape, and the reason the original error was so confusing.
   */
  const [retryable, setRetryable] = useState(true);

  // Guards a state write after unmount, and two issuances racing.
  const alive = useRef(true);
  const inFlight = useRef(false);
  /** The operation to re-run when the user taps "Try again". */
  const lastAction = useRef<(() => Promise<unknown>) | null>(null);

  /**
   * Report a failure using the reason the throw actually carried.
   *
   * The previous version collapsed every non-`ApiError` into one sentence, which threw away
   * the only information that mattered: a missing native module, a locked keystore and a
   * bad JWK all read as "Could not issue your passport." Any `Error` has a message worth
   * showing — only a non-Error needs a fallback.
   */
  const report = useCallback((caught: unknown, fallback: string) => {
    if (!alive.current) return;
    if (caught instanceof HolderKeyError) {
      setError(caught.message);
      // NATIVE_MODULE_MISSING cannot be retried away; the app itself has to change.
      setRetryable(caught.reason !== 'NATIVE_MODULE_MISSING');
      return;
    }
    setRetryable(true);
    setError(caught instanceof Error && caught.message ? caught.message : fallback);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    try {
      const [next, pending, hasKey] = await Promise.all([
        passportService.wallet(),
        // A failure here must not blank the wallet: the passport is the point, and the inbox
        // is a secondary affordance.
        passportService.pendingRequests().catch(() => []),
        hasHolderKey().catch(() => false),
      ]);
      if (!alive.current) return;
      setWallet(next);
      setRequests(pending);
      setKeyMissing(isActivePassport(next) && !hasKey);
      setError(null);
      setRetryable(true);
    } catch (caught) {
      lastAction.current = null;
      report(caught, 'Could not load your passport.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [report]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => void refetch(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refetch]);

  /**
   * Issue (or re-issue) the passport.
   *
   * Returns the outcome rather than only setting state, so a screen can show the issuer's
   * `notes` — for example that a passport binding was asked for but no verified passport is on
   * file. Silently dropping that would leave the user believing they hold a cross-border
   * credential they do not.
   */
  const issue = async (opts: { bindPassportNumber?: boolean; deviceLabel?: string } = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy('issue');
    setError(null);
    // Recorded BEFORE the attempt, so "Try again" re-runs the issuance rather than a
    // refetch that leaves the error on screen — which is what made the failure look inert.
    lastAction.current = () => issue(opts);
    try {
      // Step 1: the device key. Idempotent, so a retry after a failed step 2 reuses the
      // SAME key rather than orphaning the credential it was about to be bound to.
      const holderPublicJwk = await ensureHolderKey();

      // Step 2: bind it into a credential.
      const issued = await passportService.issue({
        holderPublicJwk,
        bindPassportNumber: opts.bindPassportNumber ?? false,
        deviceLabel: opts.deviceLabel,
      });

      await rememberCredential(issued.credentialId, issued.credentialNumber);
      await refetch();
      return issued;
    } catch (caught) {
      report(caught, 'Could not issue your passport.');
      return null;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  /**
   * The holder kills their own passport.
   *
   * The device key is destroyed too, and that ordering is deliberate: revoke server-side
   * first, then forget locally. If the local wipe ran first and the request then failed, the
   * user would be left with a live credential they could no longer present OR revoke.
   *
   * Forgetting the key at all is the point — the key IS the binding, so keeping it after a
   * revocation would preserve the ability to present a credential the user has disowned.
   */
  const revoke = async (credentialId: string) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy('revoke');
    setError(null);
    lastAction.current = () => revoke(credentialId);
    try {
      await passportService.revoke(credentialId);
      await forgetHolderKey();
      await refetch();
      return true;
    } catch (caught) {
      report(caught, 'Could not revoke your passport.');
      return false;
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  /** Re-run whatever failed. Falls back to a refetch when nothing was in flight. */
  const retry = async () => {
    const action = lastAction.current ?? refetch;
    await action();
  };

  return {
    wallet,
    requests,
    loading,
    issuing: busy === 'issue',
    revoking: busy === 'revoke',
    keyMissing,
    error,
    /** False when the failure needs a new app build rather than another tap. */
    retryable,
    refetch,
    retry,
    issue,
    revoke,
  };
}
