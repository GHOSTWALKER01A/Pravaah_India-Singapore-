import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, passportService } from '@/api';

/**
 * The machine-readable face's state, as a closed set.
 *
 * A union rather than `{ code, loading, error }` because the five situations need five
 * DIFFERENT things drawn, and only one of them is a code. Collapsing them into
 * "have it / don't" is what produces the two worst outcomes on this surface: a dead code
 * that still looks scannable, and an empty window with no way out of it.
 *
 * `UNAVAILABLE` and `NONE` look alike and are not: one needs a passport issued (a flow),
 * the other needs one tap (a mint). Telling them apart is the whole reason the verso can
 * offer the right action instead of a shrug.
 */
export type PassportCode =
  /** In flight. Nothing is known yet — draw a spinner, never an absence. */
  | { state: 'LOADING' }
  /** No credential to point a code at. The holder has to issue their passport first. */
  | { state: 'UNAVAILABLE' }
  /** A live credential, but no reference minted yet. One tap fixes it. */
  | { state: 'NONE' }
  /**
   * Reported lost. The server withholds `verifyUrl` on a disabled card, so there is
   * genuinely nothing to encode — and drawing the last-known code would hand out a
   * symbol that resolves to a 403 at a counter.
   */
  | { state: 'DISABLED' }
  | {
      state: 'READY';
      /**
       * The exact string the physical card's QR and NFC tag carry.
       *
       * An opaque reference, never the credential: scanning it opens a request THIS
       * device must approve and sign. That is what makes the code safe to print on a
       * plate a stranger is looking at, and safe to photograph.
       */
      payload: string;
      cardSerial: string;
      credentialNumber: string | null;
      expiresAt: string | null;
    }
  | {
      state: 'ERROR';
      message: string;
      /**
       * What would actually help.
       *
       * A failed LOAD is worth another tap. A failed MINT usually is not: the one reason
       * the server refuses is that there is no live credential to point a card at — which
       * is a trip to the wallet, not a retry. Offering "try again" for that is a loop the
       * holder cannot escape, and the message telling them so would be the only way out.
       */
      recover: 'retry' | 'issue';
    };

interface UsePassportCodeOptions {
  /**
   * Whether a code could exist at all.
   *
   * Passed in rather than discovered, because the caller already knows: a card requires an
   * ISSUED credential, which requires a verified identity and a computed score. Without
   * this the hook would spend a request on every unverified user to be told `null`, and
   * would then be unable to say WHY the answer was empty.
   */
  enabled?: boolean;
}

/**
 * Everything the passport's verso needs, in one request.
 *
 * `GET /passport/card` is the only call: it carries the verify URL, the credential number
 * and the expiry, and returns `null` when no card has been minted. The wallet's fuller
 * `usePassport` is deliberately NOT reused here — the home plate needs a code and two
 * identifiers, not a credential, an inbox and a device-key check, and polling all of that
 * behind a face nobody has turned over yet is a cost the first screen should not pay.
 */
export function usePassportCode({ enabled = true }: UsePassportCodeOptions = {}) {
  const [code, setCode] = useState<PassportCode>(
    enabled ? { state: 'LOADING' } : { state: 'UNAVAILABLE' },
  );
  const [creating, setCreating] = useState(false);

  // Guards a state write after unmount, and two mints racing.
  const alive = useRef(true);
  const minting = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setCode({ state: 'UNAVAILABLE' });
      return;
    }
    try {
      const card = await passportService.card();
      if (!alive.current) return;
      setCode(describe(card));
    } catch (caught) {
      if (!alive.current) return;
      setCode({
        state: 'ERROR',
        recover: 'retry',
        message:
          caught instanceof ApiError
            ? caught.message
            : 'Could not load your scan code.',
      });
    }
  }, [enabled]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  /**
   * Mint the reference behind the code.
   *
   * `POST /passport/card` is idempotent and re-points an existing card at a refreshed
   * credential, so this is safe to call from a surface the holder may tap twice. It is
   * NOT called automatically on first flip: it writes a row and an audit entry, and a
   * side effect a swipe caused is a side effect nobody consented to.
   */
  const create = useCallback(async () => {
    if (minting.current) return;
    minting.current = true;
    setCreating(true);
    try {
      const card = await passportService.issueCard();
      if (alive.current) setCode(describe(card));
    } catch (caught) {
      if (alive.current) {
        setCode({
          state: 'ERROR',
          recover: 'issue',
          // The server's own words: "Issue your passport before requesting a card" is
          // actionable, and a generic failure sentence would throw it away.
          message:
            caught instanceof ApiError
              ? caught.message
              : 'Could not create your scan code.',
        });
      }
    } finally {
      minting.current = false;
      if (alive.current) setCreating(false);
    }
  }, []);

  return { code, creating, refetch, create };
}

/** Map a card payload — or its absence — onto the face's state. */
function describe(
  card: Awaited<ReturnType<typeof passportService.card>>,
): PassportCode {
  if (!card) return { state: 'NONE' };
  // Keyed off the URL rather than off `status`, because the URL is what actually gets
  // encoded: the server withholds it on a disabled card, and trusting the status while
  // encoding the URL is how a client ends up drawing a symbol from `null`.
  if (!card.verifyUrl) return { state: 'DISABLED' };
  return {
    state: 'READY',
    payload: card.verifyUrl,
    cardSerial: card.cardSerial,
    credentialNumber: card.credentialNumber,
    expiresAt: card.expiresAt,
  };
}
