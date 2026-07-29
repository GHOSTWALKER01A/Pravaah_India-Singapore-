import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  FieldGrid,
  FieldRow,
  Header,
  Legend,
  Micro,
  Notice,
  Rule,
  Screen,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import {
  beneficiaryService,
  transferService,
} from '@/api/payments/services';
import type {
  BeneficiaryView,
  PurposeCode,
  QuoteView,
} from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import {
  AmountLine,
  FxBreakdown,
  NameConfirmation,
  PayeeLine,
  Perforation,
} from '@/features/payments/components';
import {
  CORRIDOR_META,
  PURPOSE_LABEL,
  formatCountdown,
  typeForPurpose,
} from '@/features/payments/meta';
import { keyForQuote } from '@/features/payments/use-idempotency-key';
import { resolveDeviceId } from '@/features/security/device-identity';

/**
 * Step 3: the DRAWN CHEQUE.
 *
 * The whole instrument, assembled and readable, with one thing left to do: sign it. This is where
 * the direction pays for itself, because a cheque already knows exactly what a payment
 * confirmation needs and in what order — payee line, amount in figures, amount in words, purpose,
 * date, and a signature that is the only thing standing between the instruction and the money.
 *
 * Four controls, each closing a specific failure:
 *
 * 1. **The amount appears twice, in two notations.** A mistyped zero is caught by the words.
 * 2. **The payee's BANK-HELD name is the largest thing on the plate**, and the user must tick
 *    that they read it. That tick becomes `confirmedRegisteredName` on the wire, and the server
 *    rejects the payment if the name has changed since — so it is a real control, not a gesture.
 * 3. **The rate lock has a visible countdown.** When it lapses, the numbers STAY on screen and
 *    the button becomes "Get a new price". Blanking the cheque would leave the user staring at
 *    nothing, unsure whether they had paid.
 * 4. **The idempotency key is derived from the quote id.** One priced intent is one payment,
 *    forever — including across a force-quit. A key minted at tap time would let a double-tap
 *    become two debits, which is the single worst bug this screen could have.
 */
export function SendConfirmScreen() {
  const params = useLocalSearchParams<{
    beneficiaryId: string;
    quoteId: string;
    purposeCode: string;
    narration?: string;
    /** Display figures, carried from step 2. See the note on the effect below. */
    q: string;
  }>();
  const router = useRouter();
  const p = usePalette();

  const [payee, setPayee] = useState<BeneficiaryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * `null` means NOT YET MEASURED, which is a different fact from "no time left".
   *
   * This was `useState(0)`, and that was safe only by accident: `quote` used to arrive from an effect,
   * so it was null on the first render and the `expired` test below short-circuited. Now that the
   * quote is derived and available immediately, a `0` initial value would make `expired` true for one
   * frame — flashing "Price expired · Get a new price" over a perfectly live cheque before the
   * timer's first tick. Distinguishing unmeasured from zero is what removes the flash.
   */
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const purposeCode = params.purposeCode as PurposeCode;

  /**
   * The key for this payment. Derived, not generated.
   *
   * `keyForQuote(quoteId)` is stable across every render, every retry, and a full app restart —
   * because the quote id is server-minted and single-use, so "this priced intent" already has an
   * identity. No memoisation needed or wanted: it is a pure string function of the quote id, so
   * it returns the identical value every render whether anything memoises it or not. (Contrast
   * `useIdempotencyKey`, which MINTS a random key and therefore holds it in a ref — memoisation
   * would not be a strong enough guarantee there.)
   */
  const idempotencyKey = keyForQuote(params.quoteId);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bene = await beneficiaryService.detail(params.beneficiaryId);
        if (!alive) return;
        setPayee(bene);
        setLoadError(null);
      } catch (caught) {
        if (!alive) return;
        setLoadError(
          caught instanceof Error ? caught.message : 'Could not load this payment.',
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [params.beneficiaryId]);

  /**
   * The quote's figures arrive as route params, alongside its id.
   *
   * Deliberate, and safe for one specific reason: **these numbers cannot change what is
   * charged.** The server prices from the stored `quoteId` and independently cross-checks
   * `expectedTotalDebitMinor` against it, so a tampered or stale param can only produce a 409 —
   * never a wrong debit. They are display material with a server-side guard behind them.
   *
   * The alternative would be a GET-one-quote endpoint. Worth adding later; passing the figures
   * is not worth inventing a round trip for, and re-pricing here would be actively wrong because
   * a second quote is a second lock at a second rate.
   */
  /**
   * DERIVED, not state. This line used to be an effect, and that effect was an infinite render
   * loop that crashed the screen with "Maximum update depth exceeded".
   *
   * Two faults compounded, and either alone would have been survivable:
   *
   *  1. **`[params]` is never a stable dependency.** `useLocalSearchParams()` returns a fresh object
   *     on every render, so a dependency array containing it compares unequal every time and the
   *     effect re-runs after every render — for good.
   *  2. **`setQuote(parsed)` always stored a NEW object.** `parseQuoteParams` runs `JSON.parse`, so
   *     even for byte-identical input the result fails `Object.is` against the previous value. React
   *     therefore could never bail out of the re-render, and each pass re-triggered fault 1.
   *
   * The countdown effect below then depended on `[quote]`, so it tore down and re-created its
   * interval on every one of those renders too. The crash surfaced in `Stack.Screen`'s `setOptions`
   * only because that is where React happened to notice the depth limit — the stack trace pointed at
   * navigation, but nothing was wrong with the navigator.
   *
   * A quote parsed out of a route param is not state: it is a pure function of the URL, and it can
   * only change when the URL does. `useMemo` on the single primitive `params.q` says exactly that.
   */
  const quote = useMemo(() => parseQuoteParams({ q: params.q }), [params.q]);

  /**
   * The countdown runs off a DEADLINE, not a decrementing counter, so backgrounding the app cannot
   * leave a stale clock showing time the lock no longer has.
   *
   * Keyed on `validForMs` and the quote id rather than on the quote OBJECT. `quote` is memoised now
   * so its identity is stable, but depending on the object would make this interval's lifetime rest
   * on that memo staying correct — and re-creating a 250ms interval on every render is the kind of
   * churn that hides inside a working screen until something else makes it re-render often.
   */
  const validForMs = quote?.validForMs ?? 0;
  useEffect(() => {
    if (validForMs <= 0) return;
    const deadline = Date.now() + validForMs;
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [validForMs, params.quoteId]);

  /**
   * Expired only once the clock has actually been read. Before the first tick the lock is shown at
   * its full duration, which is true — the quote was minted moments ago.
   */
  const shownRemainingMs = remainingMs ?? validForMs;
  const expired = quote !== null && remainingMs !== null && remainingMs <= 0;
  const corridor = payee?.handleType === 'PAYNOW_UPI' ? 'CROSS_BORDER' : 'DOMESTIC';

  const onAuthorise = async () => {
    if (!payee || !quote || !confirmed || expired) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await transferService.create(idempotencyKey, {
        beneficiaryId: payee.id,
        quoteId: params.quoteId,
        type: typeForPurpose(purposeCode, corridor),
        purposeCode,
        narration: params.narration || undefined,
        expectedTotalDebitMinor: quote.totalDebit.minor,
        // The exact string the user read on this screen. The server compares it and refuses if
        // the payee has been re-verified under a different name since.
        confirmedRegisteredName: payee.registeredName ?? '',
        confirmedName: true,
        /**
         * The device authorising this payment (M6).
         *
         * Sent on every transfer, and `undefined` only if SecureStore was unreachable.
         * Omitting it does NOT avoid friction — the risk engine scores an absent device as
         * `DEVICE_UNBOUND` and the ladder challenges any sensitive action from one, so a
         * client that skipped this would guarantee a step-up on every payment rather than
         * dodging one.
         *
         * Resolved here rather than held in screen state because it is a keystore read that
         * is memoised for the process: by the time a user reaches the confirm screen the
         * value has already been resolved at boot, so this is a cache hit.
         */
        deviceId: (await resolveDeviceId()) || undefined,
      });

      /**
       * A STEP_UP comes back as a live challenge on the created payment.
       *
       * Nothing is done with it HERE, deliberately. The receipt screen renders the prompt,
       * because that is where the amount, the payee and the reference are readable while the
       * user confirms — and because the challenge is re-delivered by the detail poll, so
       * closing the app mid-confirmation strands nothing.
       *
       * Handling it on this screen would mean holding a challenge on a screen the user has
       * finished with, and a back-swipe away from it would abandon a real payment.
       */
      // A commit tick — a step completing, per the motion rules. Not on ordinary taps.
      haptic.commit();
      // `replace`, not `push`: the cheque has been written and cannot be re-signed. Leaving this
      // screen on the stack would let a back-swipe return to a confirmation for a payment that
      // has already gone out.
      router.replace(ROUTES.PAY.RECEIPT(created.id));
    } catch (caught) {
      haptic.refused();
      setSubmitError(
        caught instanceof Error
          ? caught.message
          : 'That payment could not be sent. Nothing has left your wallet.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Confirm' }} />
        <View style={styles.centre}>
          <Spinner label="Preparing your payment" />
        </View>
      </Screen>
    );
  }

  if (loadError || !payee) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Confirm' }} />
        <Notice tone="error" title="Could not open this payment">
          {loadError ?? 'That payee could not be found.'}
        </Notice>
      </Screen>
    );
  }

  const crossBorder = corridor === 'CROSS_BORDER';

  return (
    <Screen
      scroll
      footer={
        expired ? (
          <Button
            label="Get a new price"
            variant="secondary"
            onPress={() => router.back()}
            hint="The rate you were shown has lapsed"
          />
        ) : (
          <Button
            label={submitting ? 'Sending…' : 'Sign and send'}
            onPress={onAuthorise}
            disabled={!confirmed || submitting || !quote}
            loading={submitting}
            hint={
              !confirmed
                ? 'Confirm the payee’s name to continue'
                : quote
                  ? `Price held for ${formatCountdown(shownRemainingMs)}`
                  : undefined
            }
          />
        )
      }
    >
      <Stack.Screen options={{ title: 'Confirm' }} />

      <Header
        legend="Step 3 of 3"
        title="Read it, then sign"
        lede="Check the name and the amount. This is what will be sent."
      />

      {/* ── THE CHEQUE ─────────────────────────────────────────────────── */}
      <View style={[styles.cheque, { borderColor: p.ruleStrong, backgroundColor: p.panel }]}>
        {/* The leaf is still attached to the book until it is signed. */}
        <Perforation edge="top" />

        <View style={styles.chequeBody}>
          <View style={styles.chequeHead}>
            <Legend small>Pravaah · payment instruction</Legend>
            <View style={[styles.stamp, { borderColor: p.ruleStrong }]}>
              <Text role="legendSm" tone="latent">
                {CORRIDOR_META[corridor].stamp}
              </Text>
            </View>
          </View>

          <Rule />

          {/* The payee line — the largest, most-verified thing on the plate. */}
          <PayeeLine
            registeredName={payee.registeredName}
            handle={payee.handle}
          />

          <Rule />

          {/* Figures and words. */}
          {quote ? (
            <AmountLine
              minor={quote.totalDebit.minor}
              currency={quote.totalDebit.currency}
              formatted={quote.totalDebit.formatted}
              label={crossBorder ? 'Total you pay' : 'Amount'}
            />
          ) : (
            <Spinner label="Pricing" />
          )}

          <Rule />

          <FieldGrid>
            <FieldRow label="For" value={PURPOSE_LABEL[purposeCode]} />
            {params.narration ? (
              <FieldRow label="Note" value={params.narration} prose />
            ) : null}
            <FieldRow label="Date" value={today()} />
          </FieldGrid>
        </View>
      </View>

      {crossBorder && quote ? (
        <FxBreakdown
          quote={quote}
          remainingMs={shownRemainingMs}
          expired={expired}
        />
      ) : null}

      {/* ── THE SIGNATURE ──────────────────────────────────────────────── */}
      <NameConfirmation
        registeredName={payee.registeredName}
        checked={confirmed}
        onChange={setConfirmed}
      />

      {submitError ? (
        <Notice tone="error" title="Not sent">
          {submitError}
        </Notice>
      ) : null}

      {/* Real microtext: the assurances, stated rather than marketed. */}
      <Micro>
        Pravaah never sees your UPI PIN. Your bank authorises this in its own secure
        screen. If the network cannot confirm the payment we hold the money rather than
        guessing, and it can never be paid twice — this instruction has one reference for
        its whole life.
      </Micro>
    </Screen>
  );
}

/**
 * Read the display figures back out of the route param.
 *
 * Returns `null` rather than throwing on anything malformed: a bad param must degrade to "we are
 * still pricing" and let the server be the authority, not crash the confirmation screen with the
 * user's money mid-flight.
 */
function parseQuoteParams(params: { q?: string }): QuoteView | null {
  if (!params.q) return null;
  try {
    const parsed = JSON.parse(params.q) as QuoteView;
    return parsed.totalDebit?.minor ? parsed : null;
  } catch {
    return null;
  }
}

/** The date as a cheque writes it: `28 July 2026`. */
function today(): string {
  return new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  cheque: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  chequeBody: { padding: Space.lg, gap: Space.md },
  chequeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  stamp: {
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.sm,
    paddingVertical: 3,
  },
  lockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: Space.sm,
  },
  signature: {
    borderTopWidth: Hairline.base,
    borderBottomWidth: Hairline.base,
    paddingVertical: Space.lg,
    gap: Space.sm,
  },
});
