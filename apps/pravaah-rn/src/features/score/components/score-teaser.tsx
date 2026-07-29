/**
 * The compact score card.
 *
 * Kept for the consent screens, which need to show what the data is FOR without
 * leaving the flow. The passport itself no longer uses it — there the score is the
 * note's latent panel, revealed by holding it.
 *
 * The incumbent's rule is preserved and is the reason this is not just a number:
 * the confidence interval travels with the score everywhere it appears. 573 ±73
 * and 573 ±10 mean very different things, and the difference has to survive the
 * summary or the honesty of the full screen is undone by its own teaser.
 */
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { isComputedScore, type ScoreResult } from '@/api';
import { Icon, Legend, Micro, Press, Text } from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Hairline, Radius, Space, useBand, usePalette } from '@/theme';
import {
  SCORE_MIN,
  bandMeta,
  scoreFraction,
} from '@/features/score/score-meta';

export function ScoreTeaser({ score }: { score: ScoreResult }) {
  const p = usePalette();
  const bandInk = useBand();

  const computed = isComputedScore(score) ? score : null;
  const ink = computed ? bandInk(computed.band) : p.inkDim;

  const value = computed?.value ?? SCORE_MIN;
  const low = computed?.bandLow ?? value;
  const high = computed?.bandHigh ?? value;

  return (
    <Press
      onPress={() => router.push(ROUTES.SCORE.ROOT)}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={
        computed
          ? `Reputation score ${computed.value}, ${bandMeta(computed.band).label}, likely between ${low} and ${high}. Open your score.`
          : 'Open your reputation score'
      }
      style={styles.outer}
    >
      <View style={[styles.plate, { backgroundColor: p.panel, borderColor: p.rule }]}>
        <View style={styles.head}>
          <Legend small tone="faint">
            Reputation score
          </Legend>
          <Icon name="chevronRight" size={14} color={p.inkFaint} weight={1.6} />
        </View>

        {computed ? (
          <>
            <View style={styles.row}>
              <Text role="valueSm" tone="inherit" style={{ color: ink }}>
                {String(computed.value ?? '—')}
              </Text>
              <View style={styles.meta}>
                <Legend small tone="inherit" style={{ color: ink }}>
                  {bandMeta(computed.band).label}
                </Legend>
                <Micro tone="dim">likely {low}–{high}</Micro>
              </View>
            </View>

            <View style={[styles.track, { backgroundColor: p.rule }]}>
              <View
                style={[
                  styles.fill,
                  { backgroundColor: ink, width: `${scoreFraction(value) * 100}%` },
                ]}
              />
            </View>

            <Micro tone="dim">{computed.confidenceLabel}</Micro>
          </>
        ) : (
          // `score` rather than `computed` here, and narrowed by the guard: the
          // non-computed states are the only ones that carry `message`.
          !isComputedScore(score) && (
            <>
              <Text role="title">
                {score.state === 'PENDING'
                  ? 'Working out your score'
                  : score.state === 'EXPIRED'
                    ? 'Your score has expired'
                    : score.state === 'FAILED'
                      ? 'Scoring is temporarily unavailable'
                      : 'Not enough history to score yet'}
              </Text>
              <Micro tone="dim">{score.message}</Micro>
            </>
          )
        )}
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  outer: { alignSelf: 'stretch' },
  plate: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: Space.lg },
  meta: { gap: 1, paddingBottom: Space.xs },
  track: { height: 3, borderRadius: Radius.sm, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: Radius.sm },
});
