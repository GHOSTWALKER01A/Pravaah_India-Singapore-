import { StyleSheet, View } from 'react-native';

import type { InsuranceQuote } from '@/api/insurance/schemas';
import { Field, Icon, Legend, Micro, Rule, Text } from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';
import {
  frequencySuffix,
  policyDate,
  TIER_META,
} from '@/features/insurance/insurance-meta';

/**
 * The price, on the intaglio field. THE screen of M5.
 *
 * ## What this component is for
 *
 * Every other insurance app shows a premium. This one shows a premium AND what the same
 * cover would have cost somebody without the holder's record — because that difference is
 * the entire reason the product exists. An insurer looking at a migrant daily-wage worker
 * sees no salary slip and no bureau file, so they refuse or price for the worst case. M2
 * gave that person a consented, explainable record, and this plate is where they find out
 * it was worth something.
 *
 * So the comparison is not a marketing flourish, it is the deliverable. It sits ON the
 * field — the app's committed brand colour, the note itself — because this is the moment
 * the reputation becomes money.
 *
 * ## Why the comparison is server-computed
 *
 * `standardPremium` and `savingPercent` both arrive from the API. Deriving the comparison
 * here from the multiplier would round twice and could show a saving of a paisa in the
 * wrong direction on a small premium — and "you save 0%" under a premium that is genuinely
 * cheaper would discredit the one claim this screen makes.
 *
 * ## Why a SUBSTANDARD premium still shows the comparison
 *
 * When the holder is paying MORE than standard, `savingPercent` is negative and this plate
 * says so plainly rather than hiding the row. A product that only shows the comparison
 * when it flatters is a product whose comparison cannot be trusted when it does appear.
 */
export function PremiumVerdict({ quote }: { quote: InsuranceQuote }) {
  const p = usePalette();
  const tier = TIER_META[quote.riskTier];

  const cheaper = quote.savingBps > 0;
  const dearer = quote.savingBps < 0;

  return (
    <Field deep>
      <View style={styles.plate}>
        {/* ── the tier stamp ───────────────────────────────────────────────── */}
        <View style={styles.stampRow}>
          <View
            style={[
              styles.stamp,
              {
                borderColor:
                  quote.riskTier === 'SUBSTANDARD'
                    ? p.onFieldLatent
                    : p.onFieldDim,
              },
            ]}
          >
            <Legend
              small
              tone="inherit"
              style={{
                color:
                  quote.riskTier === 'SUBSTANDARD'
                    ? p.onFieldLatent
                    : p.onField,
              }}
            >
              {tier.label}
            </Legend>
          </View>
          {quote.scoreBand ? (
            <Micro tone="inherit" style={{ color: p.onFieldDim }}>
              band {quote.scoreBand.replace('_', ' ').toLowerCase()}
            </Micro>
          ) : null}
        </View>

        {/* ── the premium, as a denomination ───────────────────────────────── */}
        <View style={styles.figureRow}>
          <Text
            role="denomination"
            surface="field"
            accessibilityLabel={`Your premium is ${quote.premium.formatted} ${
              quote.frequency === 'MONTHLY' ? 'every month' : 'as a single payment'
            }`}
          >
            {quote.premium.formatted}
          </Text>
          <Text role="body" surface="field" tone="dim" style={styles.suffix}>
            {frequencySuffix(quote.frequency)}
          </Text>
        </View>

        {/* ── the comparison: the product's whole claim ────────────────────── */}
        {cheaper || dearer ? (
          <View
            style={[
              styles.comparison,
              {
                borderColor: cheaper ? p.onFieldLatent : p.onFieldCarmine,
                backgroundColor: 'transparent',
              },
            ]}
          >
            <Icon
              name={cheaper ? 'improve' : 'alert'}
              size={15}
              color={cheaper ? p.onFieldLatent : p.onFieldCarmine}
              weight={1.7}
            />
            <View style={styles.comparisonText}>
              <Text
                role="bodySmMedium"
                surface="field"
                tone="inherit"
                style={{
                  color: cheaper ? p.onFieldLatent : p.onFieldCarmine,
                }}
              >
                {cheaper
                  ? `${Math.abs(quote.savingPercent).toFixed(0)}% less than a standard applicant`
                  : `${Math.abs(quote.savingPercent).toFixed(0)}% more than a standard applicant`}
              </Text>
              <Micro tone="inherit" style={{ color: p.onFieldDim }}>
                {cheaper
                  ? `they would pay ${quote.standardPremium.formatted}${frequencySuffix(quote.frequency)} for this same cover`
                  : `a standard applicant pays ${quote.standardPremium.formatted}${frequencySuffix(quote.frequency)}`}
              </Micro>
            </View>
          </View>
        ) : null}

        <Rule onField />

        {/* ── the two facts that qualify the price ─────────────────────────── */}
        <View style={styles.grid}>
          <View style={styles.cell}>
            <Legend small tone="inherit" style={{ color: p.onFieldDim }}>
              Sum insured
            </Legend>
            <Text role="fieldSm" surface="field">
              {quote.coverage.formatted}
            </Text>
          </View>

          <View style={[styles.vrule, { backgroundColor: p.ruleOnField }]} />

          <View style={styles.cell}>
            <Legend small tone="inherit" style={{ color: p.onFieldDim }}>
              You are covered from
            </Legend>
            {/*
              A DATE, not "after 30 days".
              The question a claimant asks later is "was I covered on the 14th?", and a
              day count cannot answer it. This is also the single term policyholders most
              misunderstand, so it appears on the plate they are about to act on rather
              than in the terms they will not read.
            */}
            <Text role="fieldSm" surface="field">
              {quote.coverWouldStartFrom
                ? policyDate(quote.coverWouldStartFrom)
                : `${quote.waitingPeriodDays} days after you buy`}
            </Text>
          </View>
        </View>

        {/*
          The pricing model's version, as microtext along the base.

          The world's own device — a serial along the bottom edge of a note. It is here
          because a premium derived from somebody's financial behaviour should be
          reproducible: this string plus the quote id is what a support conversation about
          "why was I charged this" is actually argued from.
        */}
        <Micro tone="inherit" style={[styles.serial, { color: p.onFieldDim }]}>
          priced {quote.pricingModelVersion} · quote {quote.id.slice(0, 8)}
        </Micro>
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  plate: { padding: Space.xl, gap: Space.lg },
  stampRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
  stamp: {
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.sm,
    paddingVertical: 3,
  },
  figureRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.xs },
  suffix: { paddingBottom: Space.sm },
  comparison: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    padding: Space.md,
  },
  comparisonText: { flex: 1, gap: 2 },
  grid: { flexDirection: 'row', alignItems: 'stretch', gap: Space.lg },
  cell: { flex: 1, gap: Space.xs },
  vrule: { width: Hairline.base, alignSelf: 'stretch' },
  serial: { letterSpacing: 0.4 },
});
