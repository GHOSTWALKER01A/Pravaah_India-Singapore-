import { Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ScoreHistoryEntry } from '@/api';
import {
  FieldValue,
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  Text,
} from '@/components/ui';
import { SCORE_MAX, SCORE_MIN, bandMeta, scoreFraction } from '@/features/score/score-meta';
import { useScoreHistory } from '@/features/score/use-score-history';
import { Radius, Space, useBand, usePalette } from '@/theme';

/**
 * Score history — how the number moved, and under which model version.
 *
 * The incumbent's key editorial decision is kept: the model version is on every
 * row rather than tucked away, because a jump between two dates can mean either
 * "your behaviour changed" or "we changed the model", and the user is entitled to
 * tell those apart. So is the chart's scaling decision — see `Trace`.
 */
export default function ScoreHistoryScreen() {
  const p = usePalette();
  const { history, loading, error, refetch } = useScoreHistory(20);
  const [refreshing, setRefreshing] = useState(false);

  const scored = (history ?? []).filter(
    (h): h is ScoreHistoryEntry & { value: number } => h.value !== null,
  );

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
      }}
      refreshing={refreshing}
    >
      <Stack.Screen options={{ title: 'Score history' }} />

      <View style={styles.sheet}>
        <Header
          title="How your score has moved"
          lede="Every score Pravaah has computed for you, newest first, with the model version that produced it."
        />

        {loading && !history ? <ListSkeleton rows={3} label="Loading your score history" /> : null}

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {history && scored.length === 0 ? (
          <Panel pad="lg">
            <View style={styles.empty}>
              <View style={[styles.emptyGlyph, { borderColor: p.rule }]}>
                <Icon name="history" size={22} color={p.latent} />
              </View>
              <Text role="heading" center>
                No scores yet
              </Text>
              <Text role="bodySm" tone="dim" center style={styles.emptyBody}>
                Once your first score is computed it appears here, and every one
                after it — so a change is always something you can inspect rather
                than something that just happens.
              </Text>
            </View>
          </Panel>
        ) : null}

        {scored.length > 0 ? (
          <>
            <Trace entries={scored} />

            <View style={styles.list}>
              <Legend tone="faint">{`${scored.length} score${scored.length === 1 ? '' : 's'}`}</Legend>
              <Panel pad="none">
                {scored.map((entry, i) => (
                  <View key={entry.id}>
                    {i > 0 ? <Rule /> : null}
                    <HistoryRow entry={entry} previous={scored[i + 1]?.value ?? null} />
                  </View>
                ))}
              </Panel>
            </View>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * The trace: one engraved column per score, oldest on the left.
 *
 * Scaled across the OBSERVED range rather than the full 300–900 scale — the
 * incumbent's reasoning and it is right: a 40-point move is the thing worth seeing
 * and is invisible at full scale. The caption states the scaling, because a chart
 * that silently rescales itself is how a small change gets read as a large one.
 */
function Trace({ entries }: { entries: (ScoreHistoryEntry & { value: number })[] }) {
  const p = usePalette();
  const bandInk = useBand();

  // The API returns newest-first; a trace reads oldest-first.
  const values = [...entries].reverse();
  const min = Math.min(...values.map((v) => v.value));
  const max = Math.max(...values.map((v) => v.value));
  const span = Math.max(1, max - min);

  return (
    <Panel pad="lg">
      <View style={styles.chart}>
        <View style={styles.chartHead}>
          <Legend small tone="faint">
            Oldest
          </Legend>
          <FieldValue role="fieldSm" tone="dim">
            {min === max ? `steady at ${min}` : `${min}–${max}`}
          </FieldValue>
          <Legend small tone="faint">
            Latest
          </Legend>
        </View>

        <View
          style={[styles.bars, { borderBottomColor: p.ruleStrong }]}
          accessibilityRole="image"
          accessibilityLabel={`A trace of ${values.length} scores, ranging from ${min} to ${max}. Oldest first: ${values.map((v) => v.value).join(', ')}.`}
        >
          {values.map((v) => (
            <View key={v.id} style={styles.barCell}>
              <View
                style={[
                  styles.bar,
                  {
                    // 16% floor so the lowest score is still a visible mark rather
                    // than nothing at all.
                    height: `${16 + ((v.value - min) / span) * 84}%`,
                    backgroundColor: bandInk(v.band),
                  },
                ]}
              />
            </View>
          ))}
        </View>

        <Micro>
          Columns are scaled to your own range ({min}–{max}) rather than the full{' '}
          {SCORE_MIN}–{SCORE_MAX} scale, so a small real change stays visible. The
          band colour is the band each score fell in.
        </Micro>
      </View>
    </Panel>
  );
}

function HistoryRow({
  entry,
  previous,
}: {
  entry: ScoreHistoryEntry & { value: number };
  previous: number | null;
}) {
  const p = usePalette();
  const bandInk = useBand();
  const ink = bandInk(entry.band);
  const delta = previous === null ? null : entry.value - previous;

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text role="valueSm" tone="inherit" style={[styles.rowValue, { color: ink }]}>
          {String(entry.value)}
        </Text>

        <View style={styles.rowMeta}>
          <Legend small tone="inherit" style={{ color: ink }}>
            {bandMeta(entry.band).label}
          </Legend>
          <FieldValue role="fieldSm" tone="dim">
            {entry.computedAt
              ? new Date(entry.computedAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
              : '—'}
          </FieldValue>
        </View>

        {delta !== null && delta !== 0 ? (
          <View style={styles.delta}>
            <Icon
              name={delta > 0 ? 'improve' : 'factors'}
              size={13}
              color={delta > 0 ? p.cleared : p.inkDim}
              weight={1.7}
            />
            <FieldValue
              role="fieldSm"
              tone="inherit"
              style={{ color: delta > 0 ? p.cleared : p.inkDim }}
            >
              {`${delta > 0 ? '+' : '−'}${Math.abs(delta)}`}
            </FieldValue>
          </View>
        ) : null}
      </View>

      {/* Where this score sat on the FULL scale — context the observed-range
          trace above deliberately does not give. */}
      <View style={[styles.track, { backgroundColor: p.rule }]}>
        <View
          style={[
            styles.fill,
            { backgroundColor: ink, width: `${scoreFraction(entry.value) * 100}%` },
          ]}
        />
      </View>

      <View style={styles.rowFoot}>
        <Micro tone="faint">
          Model v{entry.modelVersion}
          {entry.confidence !== null ? ` · confidence ${entry.confidence.toFixed(2)}` : ''}
        </Micro>
        {entry.status !== 'COMPUTED' ? (
          <Micro tone="latent">
            {entry.status === 'OVERRIDDEN'
              ? 'Reviewed by a person'
              : entry.status === 'EXPIRED'
                ? 'Expired'
                : entry.status}
          </Micro>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  chart: { gap: Space.md },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 92,
    gap: 3,
    borderBottomWidth: 1,
    paddingBottom: 1,
  },
  barCell: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { minHeight: 3, borderRadius: 1 },

  list: { gap: Space.md },
  row: { paddingHorizontal: Space.lg, paddingVertical: Space.lg, gap: Space.md },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: Space.lg },
  rowValue: { minWidth: 74 },
  rowMeta: { flex: 1, gap: 2 },
  delta: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  track: { height: 3, borderRadius: Radius.sm, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: Radius.sm },
  rowFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: Space.sm },

  empty: { alignItems: 'center', gap: Space.md },
  emptyGlyph: {
    width: 52,
    height: 52,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  emptyBody: { maxWidth: 380 },
});
