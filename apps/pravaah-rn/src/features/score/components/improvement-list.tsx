/**
 * "How to improve" — what turns a score from a verdict into coaching.
 *
 * Every `estimatedGain` is a real counterfactual: the backend re-ran the model
 * with that one feature moved and everything else held. The backend drops any tip
 * that would gain nothing, which is why an empty list is a legitimate outcome
 * rather than a bug — there is genuinely nothing useful to advise. That reasoning
 * is the incumbent's and it stands.
 *
 * Presentation: ruled rows on one plate rather than a stack of bordered cards,
 * with the gain set in the measured face because it is a measurement, and the
 * caveat kept attached to the list rather than floated in italics at the bottom.
 */
import { StyleSheet, View } from 'react-native';

import type { ScoreImprovement } from '@/api';
import { FieldValue, Micro, Notice, Panel, Rule, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

export function ImprovementList({
  improvements,
}: {
  improvements: ScoreImprovement[];
}) {
  const p = usePalette();

  if (improvements.length === 0) {
    return (
      <Notice tone="cleared" title="Nothing worth changing right now">
        We could not find a single change that would meaningfully lift your score.
        Keeping your activity steady is what helps from here.
      </Notice>
    );
  }

  return (
    <View style={styles.wrap}>
      <Panel pad="none">
        {improvements.map((tip, i) => (
          <View key={tip.feature}>
            {i > 0 ? <Rule /> : null}
            <View style={styles.row}>
              <View style={styles.head}>
                <Text role="title" style={styles.flex}>
                  {tip.label}
                </Text>
                <View style={[styles.gain, { borderColor: p.cleared }]}>
                  <FieldValue role="fieldSm" tone="inherit" style={{ color: p.cleared }}>
                    {`+${tip.estimatedGain}`}
                  </FieldValue>
                </View>
              </View>
              <Micro tone="dim" style={styles.text}>
                {tip.plainText}
              </Micro>
            </View>
          </View>
        ))}
      </Panel>

      <Micro>
        Each figure comes from re-running the model with that one change applied and
        everything else held. Real-world results depend on the rest of your activity.
      </Micro>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.md },
  row: { paddingHorizontal: Space.lg, paddingVertical: Space.lg, gap: Space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  flex: { flex: 1 },
  gain: {
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.sm,
    paddingVertical: 2,
  },
  text: { maxWidth: 460 },
});
