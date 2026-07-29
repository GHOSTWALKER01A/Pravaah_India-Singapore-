/**
 * Step 1 of buying: how much cover.
 *
 * Its own screen rather than a section of the quote, because the two ask different
 * questions and only one of them can be answered before the other. Choosing an amount is a
 * preference; being priced is a DECISION MADE ABOUT YOU. Folding them together would put a
 * premium on screen that changes as the user drags, which teaches them the number is
 * negotiable — and it is not, it is underwritten.
 *
 * The screen also carries the exclusions BEFORE any price exists. That ordering is
 * deliberate: somebody who would not have bought this cover once they understood what it
 * excludes should find that out before we have shown them an attractive figure.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ApiError } from '@/api';
import { insuranceService } from '@/api/insurance/services';
import type { MoneyView } from '@/api/insurance/schemas';
import {
  Button,
  Header,
  Notice,
  PassportSkeleton,
  Screen,
  SectionHead,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space } from '@/theme';

import {
  CoverageDial,
  coverageSteps,
  TermsPanel,
} from '@/features/insurance/components';
import { useProduct } from '@/features/insurance/use-insurance';

export function CoverScreen({ productId }: { productId: string }) {
  const router = useRouter();
  const { product, loading, error } = useProduct(productId);

  const [selected, setSelected] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const steps = useMemo(
    () =>
      product
        ? coverageSteps(product.coverage.minMinor, product.coverage.maxMinor)
        : [],
    [product],
  );

  /**
   * Default to the SECOND rung, not the first.
   *
   * The floor of the band is the cheapest and the least useful — ₹5,000 of income
   * protection is a fortnight of wages. Opening on the floor anchors the decision at the
   * amount least likely to help, and opening on the maximum would anchor at the most
   * expensive. The second rung is a defensible starting point that the user then adjusts
   * in either direction.
   */
  const chosen = selected ?? steps[Math.min(1, steps.length - 1)]?.minor ?? null;

  /**
   * The formatted amount for the chosen rung.
   *
   * Derived from the product's own `min`/`max` MoneyView when the rung is one of those, so
   * the currency symbol and grouping come from the server. For the middle rungs there is no
   * server-formatted value available before a quote exists, so the dial formats them itself
   * — which is why `coverage-dial.tsx` carries its own grouping helper rather than
   * borrowing the payments one.
   */
  const display: MoneyView | null = useMemo(() => {
    if (!product || !chosen) return null;
    if (chosen === product.coverage.minMinor) return product.coverage.min;
    if (chosen === product.coverage.maxMinor) return product.coverage.max;
    return {
      minor: chosen,
      major: '',
      formatted: formatFromMinor(chosen, product.currency),
      currency: product.currency,
    };
  }, [product, chosen]);

  const onPrice = async () => {
    if (!product || !chosen) return;
    setPricing(true);
    setQuoteError(null);
    try {
      const quote = await insuranceService.quote({
        productId: product.id,
        coverageMinor: chosen,
      });
      /**
       * `replace`, not `push`.
       *
       * The coverage chooser is not somewhere to come back to from the quote: a quote is
       * bound to a specific coverage, so "back" from it must return to the marketplace and
       * re-quoting is a fresh decision. Pushing would leave a stale chooser under a live
       * price, and tapping its button again would mint a second quote for the same amount.
       */
      router.replace(ROUTES.INSURANCE.QUOTE(quote.id));
    } catch (err) {
      setQuoteError(
        err instanceof ApiError
          ? err.message
          : 'We could not price this cover right now. Please try again.',
      );
    } finally {
      setPricing(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <PassportSkeleton />
      </Screen>
    );
  }

  if (error || !product) {
    return (
      <Screen>
        <View style={styles.sheet}>
          <Header title="Cover" />
          <Notice tone="error">{error ?? 'This cover is not available.'}</Notice>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          label={pricing ? 'Pricing your cover…' : 'Get my price'}
          onPress={() => void onPrice()}
          loading={pricing}
          disabled={!chosen}
        />
      }
    >
      <View style={styles.sheet}>
        <Header
          title={product.label}
          lede={product.tagline ?? undefined}
        />

        {quoteError ? <Notice tone="error">{quoteError}</Notice> : null}

        <CoverageDial
          steps={steps}
          selected={chosen ?? ''}
          onSelect={setSelected}
          display={display}
          currency={product.currency}
        />

        <SectionHead title="Before you see a price" />

        {/*
          The terms, ahead of the figure.

          Somebody who would not buy this cover once they understand its exclusions should
          learn that before an attractive premium is on screen. Showing the price first and
          the exclusions after is how a product gets bought and then resented.
        */}
        <TermsPanel
          exclusions={product.exclusions}
          disclaimer={product.disclaimer}
          insurerNotice={product.insurerNotice}
          waitingPeriodDays={product.waitingPeriodDays}
          freeLookDays={product.freeLookDays}
        />
      </View>
    </Screen>
  );
}

/**
 * A minor-unit string → a display amount, for the middle rungs.
 *
 * String surgery, never `Number(minor) / 100`. A minor-unit amount can exceed 2^53 on a
 * sum insured in paise, and the screen where somebody chooses how much protection to buy
 * is the last place a rounding artefact belongs.
 */
function formatFromMinor(minor: string, currency: string): string {
  const digits = (minor.replace(/[^0-9]/g, '') || '0').padStart(3, '0');
  const whole = digits.slice(0, digits.length - 2) || '0';
  const fraction = digits.slice(digits.length - 2);
  const symbol = currency === 'INR' ? '₹' : currency === 'SGD' ? 'S$' : `${currency} `;

  const grouped =
    currency === 'INR'
      ? whole.length <= 3
        ? whole
        : `${whole
            .slice(0, -3)
            .replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${symbol}${grouped}.${fraction}`;
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
});
