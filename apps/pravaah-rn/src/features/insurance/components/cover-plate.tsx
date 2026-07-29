import { StyleSheet, View } from 'react-native';

import type { InsuranceProduct } from '@/api/insurance/schemas';
import { Icon, Legend, Micro, Press, Rule, Text } from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';
import { PRODUCT_META } from '@/features/insurance/insurance-meta';

/**
 * One cover, on the marketplace.
 *
 * ## Why there is no price on this plate
 *
 * Every insurance marketplace in the world shows "from ₹99/month" here, and this one
 * refuses to. Pricing in M5 is PERSONAL — two applicants with the same cover pay
 * different premiums because their consented behaviour differs — so a marketplace figure
 * would be one of two things: a "from" price only the best band is ever offered, or an
 * average nobody is quoted. Both teach the user to distrust the number they eventually
 * get.
 *
 * What sits in the price's place is the cover BAND and the waiting period, which are the
 * two facts that are the same for everybody and the two a person actually needs to decide
 * whether this product is about them at all.
 *
 * ## Why the waiting period is on the card and not behind a tap
 *
 * It is the single control policyholders most misunderstand, and the one that causes the
 * refusal they experience as betrayal. Naming it before they have spent anything — beside
 * the cover, in the same weight — is the difference between a term someone agreed to and
 * a term they were subjected to.
 */
export function CoverPlate({
  product,
  onPress,
}: {
  product: InsuranceProduct;
  onPress: () => void;
}) {
  const p = usePalette();
  const meta = PRODUCT_META[product.type];

  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`${product.label}. Cover from ${product.coverage.min.formatted} to ${product.coverage.max.formatted}. ${product.waitingPeriodDays}-day waiting period. Get your price.`}
      accessibilityHint="Opens the coverage chooser for this cover"
    >
      <View style={[styles.plate, { backgroundColor: p.panel, borderColor: p.rule }]}>
        <View style={styles.head}>
          <View style={[styles.mark, { borderColor: p.ruleStrong }]}>
            <Icon name={meta.icon} size={18} color={p.field} weight={1.6} />
          </View>
          <View style={styles.headText}>
            <Text role="title">{product.label}</Text>
            {product.tagline ? (
              <Micro tone="dim" style={styles.tagline}>
                {product.tagline}
              </Micro>
            ) : null}
          </View>
          <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
        </View>

        <Rule inset={0} />

        {/*
          Cover and wait, side by side and equally weighted.

          A grid rather than a list, because these two facts qualify each other: cover
          without its waiting period reads as protection available today, and every
          disappointed claim in micro-insurance starts there.
        */}
        <View style={styles.facts}>
          <View style={styles.fact}>
            <Legend small tone="faint">
              Cover
            </Legend>
            <Text role="bodySmMedium">
              {product.coverage.min.formatted} – {product.coverage.max.formatted}
            </Text>
          </View>

          <View style={[styles.divider, { backgroundColor: p.rule }]} />

          <View style={styles.fact}>
            <Legend small tone="faint">
              Cover starts after
            </Legend>
            <View style={styles.waitRow}>
              <Icon name="hourglass" size={13} color={p.latent} weight={1.6} />
              <Text role="bodySmMedium">
                {product.waitingPeriodDays === 0
                  ? 'straight away'
                  : `${product.waitingPeriodDays} days`}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.cta}>
          <Legend small tone="inherit" style={{ color: p.field }}>
            Get my price
          </Legend>
          {/*
            Stated on every card, because the absence of a price is otherwise read as a
            missing feature rather than as the deliberate thing it is.
          */}
          <Micro tone="faint">priced from your Pravaah score</Micro>
        </View>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  plate: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  mark: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    borderWidth: Hairline.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1, gap: 2 },
  tagline: { maxWidth: 260 },
  facts: { flexDirection: 'row', alignItems: 'stretch', gap: Space.lg },
  fact: { flex: 1, gap: Space.xs },
  divider: { width: Hairline.base, alignSelf: 'stretch' },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  cta: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
});
