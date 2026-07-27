/**
 * Where you are in the corridor's sequence — shown at the top of every step screen.
 *
 * Was: a row of `flex: 1` coloured pills, 6dp tall, plus "Step 3 of 6 · Bank
 * account". The pills carried four colours (green / indigo / red / amber) mapped
 * to check status, which meant the progress indicator and the status system were
 * two different colour languages sitting 200px apart on the same screen.
 *
 * Here it is one impressed rule with a tick per step, and a caption naming the
 * step you are on. It reads as an instrument scale, which is what it is.
 */
import { StyleSheet, View } from 'react-native';

import type { CheckType, KycProfileStatus } from '@/api';
import { Legend, Text } from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { CHECK_META } from '../check-labels';
import { REQUIRED_CHECKS, checkStatusOf } from '../flow';

export function FlowProgress({
  status,
  current,
}: {
  status: KycProfileStatus;
  current: CheckType;
}) {
  const p = usePalette();
  const required = REQUIRED_CHECKS[status.country];
  const index = required.indexOf(current);
  const label = CHECK_META[current]?.label ?? current;

  return (
    <View
      style={styles.wrap}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${index + 1} of ${required.length}: ${label}`}
    >
      <View style={styles.scale}>
        {required.map((type, i) => {
          const passed = checkStatusOf(status, type) === 'PASSED';
          const here = type === current;
          return (
            <View
              key={type}
              style={[
                styles.tick,
                {
                  backgroundColor: passed || i < index ? p.latentLine : p.rule,
                  // The step you are ON is the only tall mark. Everything else is
                  // the scale; this is the needle.
                  height: here ? 8 : Hairline.thick + 1,
                },
                here && { backgroundColor: p.latent },
              ]}
            />
          );
        })}
      </View>

      <View style={styles.caption}>
        <Legend small tone="faint">
          {`Step ${index + 1} of ${required.length}`}
        </Legend>
        <Text role="micro" tone="dim">
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.sm },
  scale: { flexDirection: 'row', gap: Space.xs, alignItems: 'flex-end', height: 8 },
  tick: { flex: 1, borderRadius: Radius.sm },
  caption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
});
