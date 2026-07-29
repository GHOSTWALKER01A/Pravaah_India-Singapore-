import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MoneyView } from '@/api/insurance/schemas';
import { Icon, Legend, Micro, Press, Text } from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

/**
 * Choosing how much cover.
 *
 * ## Why steps and not a slider
 *
 * A continuous slider is what this looks like it should be, and it is wrong for this
 * decision. Cover is not a preference to be tuned — it is a small set of meaningful
 * amounts (a fortnight of wages, a month, three months), and a slider invites somebody to
 * land on ₹18,340 of income protection, which corresponds to nothing they can name. Worse,
 * a slider on a 360dp phone with a ₹5,000–₹50,000 band moves in ~₹500 jumps per pixel of
 * thumb travel, so the value the user *meant* is not reliably reachable by a fingertip.
 *
 * Discrete steps also make the price legible: each tap produces one new premium the user
 * can compare against the last, rather than a figure that slides continuously and never
 * settles into something memorable.
 *
 * ## Why the steps are computed rather than hard-coded
 *
 * The band comes from the product catalogue, which an admin can change without a deploy.
 * Hard-coded amounts would silently fall outside the band the moment a product was
 * repriced, and the server would then reject a coverage the UI had offered.
 */

/** How many choices to offer between the product's floor and ceiling, inclusive. */
const STEP_COUNT = 5;

export interface CoverageStep {
  /** Integer minor units, as a digit string — the shape the API takes. */
  minor: string;
  label: string;
}

/**
 * Build the ladder.
 *
 * Rounded to a "human" unit — ₹1,000 where the band allows it, otherwise the largest
 * power of ten that still gives distinct steps. The rounding is what turns an arithmetic
 * interval into an amount somebody can hold in their head, and the fallback is what keeps
 * a narrow band (say ₹500–₹2,000) from collapsing into five identical rungs.
 */
export function coverageSteps(
  minMinor: string,
  maxMinor: string,
): CoverageStep[] {
  const min = BigInt(minMinor || '0');
  const max = BigInt(maxMinor || '0');
  if (max <= min) {
    return [{ minor: min.toString(), label: 'the only amount on offer' }];
  }

  const span = max - min;
  const gap = span / BigInt(STEP_COUNT - 1);

  // The coarsest round unit that still leaves the rungs distinct. `100_000n` is ₹1,000
  // in paise; the ladder walks down until the gap is at least one unit wide.
  const units = [100_000n, 10_000n, 1_000n, 100n, 1n];
  const unit = units.find((candidate) => gap >= candidate) ?? 1n;

  const steps: CoverageStep[] = [];
  for (let index = 0; index < STEP_COUNT; index++) {
    const raw = min + gap * BigInt(index);
    // Snap to the unit, then clamp — snapping alone can overshoot the ceiling on the
    // last rung, and offering cover above the product's maximum is a request the
    // server will refuse after the user has chosen it.
    const snapped = index === 0 ? min : index === STEP_COUNT - 1 ? max : (raw / unit) * unit;
    const bounded = snapped > max ? max : snapped < min ? min : snapped;
    const value = bounded.toString();
    if (!steps.some((step) => step.minor === value)) {
      steps.push({ minor: value, label: '' });
    }
  }
  return steps;
}

export function CoverageDial({
  steps,
  selected,
  onSelect,
  /** The formatted amount for the current selection, from the server's own view. */
  display,
  currency,
}: {
  steps: CoverageStep[];
  selected: string;
  onSelect: (minor: string) => void;
  display: MoneyView | null;
  currency: string;
}) {
  const p = usePalette();

  const formatted = useMemo(
    () => steps.map((step) => ({ ...step, label: majorLabel(step.minor, currency) })),
    [steps, currency],
  );

  return (
    <View style={styles.wrap}>
      <Legend small tone="faint">
        How much cover
      </Legend>

      {/*
        The chosen amount, as a denomination.

        In Bodoni at display weight because this is the figure the whole screen is about,
        and because the world's rule is that a denomination is set in Bodoni. It updates
        on every tap so the relationship between the rung and the sum is immediate.
      */}
      <View style={styles.denomination}>
        <Text role="denominationSm" accessibilityLiveRegion="polite">
          {display?.formatted ?? '—'}
        </Text>
        <Micro tone="dim">sum insured</Micro>
      </View>

      <View style={styles.ladder} accessibilityRole="radiogroup">
        {formatted.map((step) => {
          const active = step.minor === selected;
          return (
            <Press
              key={step.minor}
              onPress={() => onSelect(step.minor)}
              depth="subtle"
              radius={Radius.sm}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${step.label} of cover`}
              style={styles.rungPress}
            >
              <View
                style={[
                  styles.rung,
                  {
                    borderColor: active ? p.field : p.rule,
                    backgroundColor: active ? p.fieldWash : 'transparent',
                  },
                ]}
              >
                <Text
                  role="bodySmMedium"
                  tone="inherit"
                  style={{ color: active ? p.cleared : p.inkDim }}
                >
                  {step.label}
                </Text>
                {active ? (
                  <Icon name="check" size={12} color={p.cleared} weight={2} />
                ) : null}
              </View>
            </Press>
          );
        })}
      </View>
    </View>
  );
}

/**
 * A short major-unit label for a rung — `₹20,000`, never `₹20,000.00`.
 *
 * Trailing paise on a rung is noise: every amount on this ladder is a round figure by
 * construction, and two decimal places of zeros make five rungs harder to compare at a
 * glance. The full precision is on the denomination above, which comes from the server.
 */
function majorLabel(minor: string, currency: string): string {
  const digits = (minor.replace(/[^0-9]/g, '') || '0').padStart(3, '0');
  const whole = digits.slice(0, digits.length - 2) || '0';
  const symbol = currency === 'INR' ? '₹' : currency === 'SGD' ? 'S$' : '';
  const grouped =
    currency === 'INR' ? groupIndian(whole) : groupWestern(whole);
  return `${symbol}${grouped}`;
}

/** INR groups 2,2,3 from the right — `₹12,34,567`, not `₹1,234,567`. */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const styles = StyleSheet.create({
  wrap: { gap: Space.md },
  denomination: { gap: 2 },
  ladder: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  rungPress: { flexGrow: 1, flexBasis: '30%' },
  rung: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    paddingVertical: Space.md,
    paddingHorizontal: Space.sm,
  },
});
