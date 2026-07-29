/**
 * Step 2 of buying: the price, and the decision.
 *
 * The reputation moment. Everything on this screen exists to make one thing legible: the
 * holder is being charged less than a stranger would be, BECAUSE of a record they chose to
 * share. That is the product.
 *
 * ## The four things this screen refuses to do
 *
 *  - **It does not hide a DECLINE behind an error.** A decline renders as a full component
 *    with the reason and two working routes back to eligibility. See `DeclineNotice`.
 *  - **It does not let the disclaimer be defaulted through.** `acceptedDisclaimer` is a
 *    literal `true` on the wire and an explicit checkbox here. An insurance purchase nobody
 *    acknowledged is not a purchase.
 *  - **It does not treat an empty wallet as a failure.** `collected: false` is the ordinary
 *    case for a daily-wage earner. The policy exists at the agreed price; the screen says
 *    what to add and where.
 *  - **It does not re-price on retry.** The idempotency key is minted once, when the screen
 *    mounts with a priced quote, and reused for every retry — so a double-tap collapses onto
 *    one purchase rather than two months of premium.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ApiError } from '@/api';
import { insuranceService } from '@/api/insurance/services';
import {
  Button,
  Checkbox,
  Header,
  Icon,
  Legend,
  Micro,
  Notice,
  Panel,
  PassportSkeleton,
  Screen,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

import {
  DeclineNotice,
  PremiumVerdict,
  TermsPanel,
} from '@/features/insurance/components';
import { frequencyLabel, relativeDays } from '@/features/insurance/insurance-meta';
import { useQuote } from '@/features/insurance/use-quote';

export function QuoteScreen({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const p = usePalette();
  const { quote, loading, error } = useQuote(quoteId);

  const [accepted, setAccepted] = useState(false);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [shortfall, setShortfall] = useState<string | null>(null);

  /**
   * One key for this purchase intent, minted at mount.
   *
   * NOT inside the submit handler. A key generated per invocation would be fresh on every
   * retry, and the server would correctly read a second key as a second purchase — debiting
   * a policyholder twice for one month of cover. This is the same twenty lines M4 relies on,
   * reused rather than re-implemented.
   */
  const { key: idempotencyKey } = useIdempotencyKey();

  const onBuy = async () => {
    if (!quote) return;
    setBuying(true);
    setBuyError(null);
    setShortfall(null);
    try {
      const result = await insuranceService.buy(idempotencyKey, {
        quoteId: quote.id,
        // The premium as printed on the button. A cross-check, not an instruction — the
        // server refuses to proceed if the quote disagrees, rather than silently charging
        // the correct-but-unseen figure.
        expectedPremiumMinor: quote.premium.minor,
        acceptedDisclaimer: true,
      });

      if (result.collected) {
        // `replace`: the quote is spent. Returning to it would show a price that can no
        // longer be bought.
        router.replace(ROUTES.INSURANCE.POLICY(result.policy.id));
        return;
      }

      /**
       * The premium could not be funded.
       *
       * The policy EXISTS, at the agreed price, awaiting payment — so the holder is sent to
       * it rather than left on a dead quote. The shortfall is surfaced first so they know
       * what to add before they get there.
       */
      setShortfall(result.shortfall?.formatted ?? null);
      setBuyError(result.message);
      router.replace(ROUTES.INSURANCE.POLICY(result.policy.id));
    } catch (err) {
      setBuyError(
        err instanceof ApiError
          ? err.message
          : 'We could not complete this purchase. Nothing has been charged.',
      );
    } finally {
      setBuying(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <PassportSkeleton />
      </Screen>
    );
  }

  if (error || !quote) {
    return (
      <Screen>
        <View style={styles.sheet}>
          <Header title="Your price" />
          <Notice tone="error">{error ?? 'This quote could not be found.'}</Notice>
        </View>
      </Screen>
    );
  }

  // ── declined ─────────────────────────────────────────────────────────────
  if (quote.riskTier === 'DECLINE') {
    return (
      <Screen>
        <View style={styles.sheet}>
          <Header title="Your price" />
          <DeclineNotice quote={quote} />
        </View>
      </Screen>
    );
  }

  // ── expired or already bought ────────────────────────────────────────────
  if (!quote.isBuyable) {
    return (
      <Screen
        footer={
          <Button
            label="Get a fresh price"
            onPress={() => router.replace(ROUTES.INSURANCE.COVER(quote.product.id))}
          />
        }
      >
        <View style={styles.sheet}>
          <Header
            title="This price has expired"
            lede={
              quote.status === 'CONVERTED'
                ? 'You have already bought this cover.'
                : 'A price stands for 30 minutes so it always reflects your current record. Ask for a new one — it is usually the same.'
            }
          />
          <PremiumVerdict quote={quote} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <View style={styles.footer}>
          {/*
            The acknowledgement, immediately above the button that acts on it.

            Not at the top of a scroll, where it would be agreed to before the exclusions
            had been read, and not inside the terms panel, where a collapsed disclosure
            could hide the thing being consented to.
          */}
          <Checkbox
            checked={accepted}
            onChange={setAccepted}
            // The accessible name is short; the visible copy is a sentence. Both are
            // required by the component, and the split is why the sentence can be written
            // for a reader rather than for a screen reader's label slot.
            label="I accept the exclusions and the non-advice notice"
          >
            <Text role="bodySm">
              I have read what is not covered, and I understand this is information rather
              than advice.
            </Text>
          </Checkbox>
          <Button
            label={
              buying
                ? 'Collecting your premium…'
                : `Buy for ${quote.premium.formatted}`
            }
            onPress={() => void onBuy()}
            loading={buying}
            disabled={!accepted}
          />
        </View>
      }
    >
      <View style={styles.sheet}>
        <Header
          title={quote.product.label}
          lede={`${quote.coverage.formatted} of cover, priced for you.`}
        />

        {buyError ? (
          <Notice tone={shortfall ? 'caution' : 'error'}>
            {buyError}
            {shortfall ? ` You are ${shortfall} short.` : ''}
          </Notice>
        ) : null}

        {/* THE plate. Everything else on this screen supports it. */}
        <PremiumVerdict quote={quote} />

        {/* ── why this price, in the underwriter's own words ─────────────────── */}
        {quote.explanation.length > 0 ? (
          <Panel pad="lg" style={styles.why}>
            <Legend small tone="faint">
              Why this price
            </Legend>
            {quote.explanation.map((line) => (
              <View key={line} style={styles.whyRow}>
                <View style={[styles.bullet, { backgroundColor: p.latentLine }]} />
                <Text role="bodySm" style={styles.whyText}>
                  {line}
                </Text>
              </View>
            ))}
            {/*
              The fairness statement, on the priced screen.

              It belongs here rather than in a policy document because this is the screen
              where somebody might reasonably wonder what was read about them. M2 never puts
              a protected attribute in the model, so there is no SHAP factor for the
              underwriter to have found — the guarantee is structural, and saying so is
              cheap.
            */}
            <Micro tone="faint">
              Your age, gender and nationality are never used to price cover. This premium
              comes from cash-flow behaviour only.
            </Micro>
          </Panel>
        ) : null}

        {/* ── what happens when you buy ──────────────────────────────────────── */}
        <Panel pad="lg" tone="sunk" style={styles.next}>
          <Legend small tone="faint">
            What happens next
          </Legend>
          <Step
            icon="pay"
            text={`${quote.premium.formatted} comes out of your Pravaah wallet now. ${frequencyLabel(quote.frequency)}.`}
          />
          <Step
            icon="hourglass"
            text={
              quote.waitingPeriodDays === 0
                ? 'Your cover starts immediately.'
                : `Your cover starts on ${
                    quote.coverWouldStartFrom
                      ? relativeDays(quote.coverWouldStartFrom).replace('in ', 'in ')
                      : `day ${quote.waitingPeriodDays}`
                  } — anything before then is not covered.`
            }
          />
          <Step
            icon="refresh"
            text={`Change your mind within ${quote.product.freeLookDays} days and you get the whole premium back.`}
          />
        </Panel>

        <TermsPanel
          exclusions={quote.exclusions}
          disclaimer={quote.nonAdviceDisclaimer}
          insurerNotice={quote.insurerNotice}
          freeLookDays={quote.product.freeLookDays}
        />

        <Micro tone="faint" center>
          This price stands until {relativeDays(quote.validUntil)}.
        </Micro>
      </View>
    </Screen>
  );
}

/** One line of "what happens next". */
function Step({
  icon,
  text,
}: {
  icon: 'pay' | 'hourglass' | 'refresh';
  text: string;
}) {
  const p = usePalette();
  return (
    <View style={styles.step}>
      <Icon name={icon} size={15} color={p.field} weight={1.6} />
      <Text role="bodySm" tone="dim" style={styles.stepText}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  footer: { gap: Space.md },
  why: { gap: Space.sm },
  whyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  bullet: { width: 3, height: 3, borderRadius: 2, marginTop: 9 },
  whyText: { flex: 1 },
  next: { gap: Space.md },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  stepText: { flex: 1 },
});
