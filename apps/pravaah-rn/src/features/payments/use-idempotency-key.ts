import { useRef, useState } from 'react';

import * as Crypto from 'expo-crypto';

/**
 * A stable idempotency key for one payment INTENT.
 *
 * This is the most important twenty lines on the client side of M4, and the reason is a bug
 * that is almost invisible in review:
 *
 * ```ts
 * // WRONG — and it looks completely fine.
 * async function onPay() {
 *   await transferService.create(Crypto.randomUUID(), request)
 * }
 * ```
 *
 * That mints a NEW key per invocation. A double-tap, a React remount, a user pressing Pay again
 * after a slow response, or the screen re-rendering mid-flight all produce a second key — and
 * the server, correctly, reads a second key as a second payment. The idempotency guarantee is
 * real but the client threw it away by generating the key in the wrong place.
 *
 * So the key is minted when the user forms the intent (the screen mounts with a priced quote),
 * held in a ref for the life of that intent, and returned unchanged however many times the
 * submit runs. The server then collapses every retry onto one transaction and replays the
 * original response.
 *
 * `reset()` exists for the one case where a NEW intent legitimately begins on the same mounted
 * screen: the user got a terminal failure, re-quoted, and is trying again. That is genuinely a
 * different payment and must not be deduped against the failed one.
 */
export function useIdempotencyKey(): {
  /** The key for the current intent. Stable across renders and retries. */
  key: string;
  /** Begin a NEW intent. Only after a terminal outcome the user has acknowledged. */
  reset: () => string;
} {
  // A ref, not state: reading the key must never depend on a render having happened, because
  // the submit handler can fire in the same tick the screen mounted.
  const keyRef = useRef<string | null>(null);
  // Mirrored into state purely so a caller that wants to DISPLAY the key (a support code on a
  // failure screen) re-renders when it changes. Nothing reads this for the request itself.
  const [, bump] = useState(0);

  if (keyRef.current === null) {
    keyRef.current = mintKey();
  }

  const reset = () => {
    const next = mintKey();
    keyRef.current = next;
    bump((n) => n + 1);
    return next;
  };

  return { key: keyRef.current, reset };
}

/**
 * A fresh key.
 *
 * `expo-crypto`'s `randomUUID` is CSPRNG-backed. The prefix is not decoration — an
 * idempotency key shows up in server logs and support conversations, and one that announces
 * which client and which flow produced it is one somebody can actually trace. The server only
 * requires 8+ characters from a restricted alphabet, which a prefixed UUID satisfies.
 */
function mintKey(): string {
  return `rn-${Crypto.randomUUID()}`;
}

/**
 * A key DERIVED from something stable, for intents that already have a natural identity.
 *
 * Paying a specific quote is the case: the quote id is minted server-side, is single-use, and
 * already means "this exact priced intent". Deriving the key from it makes the request
 * idempotent even across a full app restart — a user who force-quit mid-payment and reopened
 * the app retries the same key rather than starting a second payment.
 *
 * Not used for topup or collect, where there is no server-side single-use token to hang it on.
 */
export function keyForQuote(quoteId: string): string {
  return `rn-q-${quoteId}`;
}
