/**
 * "Why this score" — the drivers, each as a plain sentence.
 *
 * The correctness decision from the incumbent is preserved and is the reason this
 * component looks the way it does: contributions are Shapley values in the model's
 * log-odds space, so the raw number is real but not actionable, and showing it
 * would invite comparison against points. Only ORDER and RELATIVE magnitude carry
 * meaning, so only those are shown.
 *
 * The presentation changes: the incumbent drew a centred bar split across two
 * `flex: 1` halves with a hairline axis, inside a bordered card, per factor —
 * five nested boxes each containing a diverging chart. Here the factors are ruled
 * rows on one plate, the bar is a single engraved rule running from a shared axis,
 * and direction is carried by which side it runs AND by the word.
 */
import { StyleSheet, View } from 'react-native';

import type { ScoreFactor } from '@/api';
import { Legend, Micro, Panel, Rule, Text } from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';
import { factorWeight } from '@/features/score/score-meta';

export function FactorList({ factors }: { factors: ScoreFactor[] }) {
  const p = usePalette();

  if (factors.length === 0) {
    return (
      <Text role="bodySm" tone="dim">
        No factor breakdown is available for this score yet. That happens when a
        score was produced by an older model version than the one running now.
      </Text>
    );
  }

  return (
    <Panel pad="none">
      {factors.map((factor, i) => {
        const positive = factor.direction === 'POSITIVE';
        /**
         * Carmine is NOT used here, and that is a deliberate correction.
         *
         * DESIGN.md reserves the second colour for revocation, deletion, decline
         * and failure. A negative Shapley contribution is none of those — it is a
         * driver pointing the other way. Painting it carmine also undid the whole
         * reason the band ramp has no red at the bottom: a weaker score is a
         * starting point, not a rejection. Direction is carried by the WORD
         * ("Held back") and by the bar's weight, which is enough.
         */
        const ink = positive ? p.cleared : p.inkDim;
        const weight = factorWeight(factor.contribution, factors);

        return (
          <View key={factor.feature}>
            {i > 0 ? <Rule /> : null}
            <View style={styles.row}>
              <View style={styles.head}>
                <Text role="title" style={styles.flex}>
                  {factor.label}
                </Text>
                <Legend small tone="inherit" style={{ color: ink }}>
                  {positive ? 'Helped' : 'Held back'}
                </Legend>
              </View>

              {/* One rule from a shared left axis. Relative length is the whole
                  message; there is no scale because there is no unit worth
                  printing. */}
              <View style={[styles.track, { backgroundColor: p.rule }]}>
                <View
                  style={[
                    styles.bar,
                    { backgroundColor: ink, width: `${weight * 100}%` },
                  ]}
                />
              </View>

              <Micro tone="dim" style={styles.text}>
                {factor.plainText}
              </Micro>
            </View>
          </View>
        );
      })}
    </Panel>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: Space.lg, paddingVertical: Space.lg, gap: Space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  flex: { flex: 1 },
  track: { height: Hairline.thick + 1.5, borderRadius: Radius.sm, overflow: 'hidden' },
  bar: { height: '100%', borderRadius: Radius.sm },
  text: { maxWidth: 460 },
});
