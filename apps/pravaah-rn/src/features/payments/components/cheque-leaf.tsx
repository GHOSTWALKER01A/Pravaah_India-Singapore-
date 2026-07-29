import { StyleSheet, View } from 'react-native';

import {
  CornerMedallion,
  Field,
  Legend,
  Micro,
  Rule,
  Text,
} from '@/components/ui';
import { Gutter, Hairline, Radius, Space, usePalette } from '@/theme';

import type { LimitView, MoneyView } from '@/api/payments/schemas';

import { formatResetAt } from '../meta';
import { useBalanceReveal } from '../use-balance-reveal';
import { LatentFigure } from './latent-figure';
import { Perforation } from './perforation';

/**
 * The current leaf of the cheque book — the first viewport of the Pay tab.
 *
 * The composition is the object: a full-bleed intaglio plate whose TOP EDGE IS PERFORATED,
 * because the leaves above it have already been torn out and spent. That single device is what
 * makes the balance read as "what is left in the book" rather than as a dashboard metric, and it
 * is why this is not the hero-number template the category ships.
 *
 * What is on the leaf, and why each thing is there:
 *
 * - **The balance as a Bodoni denomination.** It is the note's own way of stating value.
 * - **The remaining daily limit, on the same line of the same plate.** Not a separate card. A
 *   balance without the cap is misleading: ₹48,250 held with ₹2,000 of limit left cannot send
 *   ₹10,000, and discovering that at the confirmation screen is worse than being told here. This
 *   is the one fact every other payments app hides in a settings screen.
 * - **The corridor stamp**, the note's multi-language panel reduced to what the app can honestly
 *   localise into.
 * - **Microtext along the base** carrying the reset time and the count cap — real text at the
 *   microtext size, as DESIGN.md requires, not a decorative squiggle.
 *
 * The primary actions sit BELOW the plate on rag, never on the field. That is the inherited
 * rule from the passport and it holds for the same reason: the field is the object, and a button
 * on it would make the object a container.
 */
interface ChequeLeafProps {
  balance: MoneyView | null;
  limits: LimitView | null;
  /** `IN` or `SG → IN`. */
  stamp: string;
  /** The user's own UPI ID, printed along the base like a serial. */
  vpa?: string | null;
}

export function ChequeLeaf({ balance, limits, stamp, vpa }: ChequeLeafProps) {
  const p = usePalette();
  const { revealed, reveal, conceal } = useBalanceReveal();

  return (
    // The shadow lives on an OUTER wrapper and the clipping on the inner `Field`: `overflow:
    // hidden` sets `masksToBounds` on iOS, which kills the shadow entirely. Same trap the
    // passport hit.
    <View style={styles.lift}>
      <Field radius={Radius.lg} style={styles.leaf}>
        {/* The tear edge. The leaves above this one are gone. */}
        <View style={styles.tear}>
          <Perforation edge="top" onField />
        </View>

        <CornerMedallion size={92} top={-14} right={-18} />

        <View style={styles.body}>
          <View style={styles.head}>
            <Legend small surface="field">
              Balance in hand
            </Legend>
            {/* The corridor stamp: the note's multi-language panel, honestly reduced. */}
            <View style={[styles.stamp, { borderColor: p.ruleOnFieldStrong }]}>
              <Text role="legendSm" surface="field" tone="latent">
                {stamp}
              </Text>
            </View>
          </View>

          <LatentFigure
            balance={balance}
            revealed={revealed}
            onReveal={reveal}
            onConceal={conceal}
            label="Balance in hand"
          />

          <Rule onField strong />

          {/*
            The limits as a DATA-FIELD GRID — legend left, value right, full measure — rather than
            two side-by-side cells.

            The two-cell split was a real bug, not a style preference: each cell got roughly 45% of a
            360dp screen, and `₹1,00,000.00` at the value size does not fit in ~145dp, so the daily
            cap rendered as "₹1,00,00 / 0.00" — a money figure broken across two lines mid-number, on
            the plate a user reads to decide what they can send. Full measure fits the largest figure
            either rail can produce, and DESIGN.md already names the data-field grid as the default
            for "anything that is a set of facts".
          */}
          {limits ? (
            <View style={styles.limits}>
              <LimitRow
                label="Left to send today"
                value={limits.dailyRemaining.formatted}
              />
              <Rule onField />
              <LimitRow
                label="Most in one payment"
                value={limits.perTransaction.formatted}
              />
            </View>
          ) : null}
        </View>

        {/* Microtext along the base — real text, as the world requires. */}
        <View style={[styles.foot, { borderTopColor: p.ruleOnField }]}>
          <Micro surface="field" numberOfLines={1} style={styles.serial}>
            {vpa ?? 'no upi id yet'}
          </Micro>
          {limits ? (
            <Micro surface="field" numberOfLines={1}>
              {limits.dailyCountCap > 0
                ? `${limits.dailyUsedCount}/${limits.dailyCountCap} today · resets ${formatResetAt(limits.resetAt)}`
                : `resets ${formatResetAt(limits.resetAt)}`}
            </Micro>
          ) : null}
        </View>
      </Field>
    </View>
  );
}

/**
 * One limit, as a data-field row on the plate.
 *
 * The value is mono and `numberOfLines={1}`: an amount is a measurement, and a measurement that
 * wraps has stopped being one. It shrinks its label rather than itself, because the label is prose
 * and can take a second line where the figure cannot.
 */
function LimitRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.limitRow}>
      <Legend small surface="field" style={styles.limitLabel}>
        {label}
      </Legend>
      <Text
        role="valueSm"
        surface="field"
        numberOfLines={1}
        style={styles.limitValue}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-bleed: the field owns its region to the screen edges, per the composition rule.
  lift: {
    marginHorizontal: -Gutter,
    shadowColor: '#082018',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  leaf: { borderRadius: 0 },
  tear: { paddingTop: Space.sm },
  body: { paddingHorizontal: Gutter, paddingTop: Space.lg, gap: Space.md },
  head: {
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
  limits: { gap: Space.sm },
  limitRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
    minHeight: 24,
  },
  // The label yields, the figure does not. `flexShrink: 1` on prose and `0` on the amount is what
  // guarantees the money keeps its full measure at every OS font size.
  limitLabel: { flexShrink: 1 },
  limitValue: { flexShrink: 0 },
  foot: {
    marginTop: Space.lg,
    paddingHorizontal: Gutter,
    paddingVertical: Space.sm,
    borderTopWidth: Hairline.base,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  serial: { letterSpacing: 0.6 },
});
