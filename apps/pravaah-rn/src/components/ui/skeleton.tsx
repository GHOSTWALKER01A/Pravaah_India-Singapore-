/**
 * Loading placeholders.
 *
 * The incumbent showed a centred spinner on eight screens and a static grey-bar
 * skeleton on one. A spinner on a whole screen tells the user nothing about what
 * is arriving; the audience here is on metered mobile data and that wait is often
 * seconds long.
 *
 * These are the shapes of the content that is coming, pulsing on a slow breath.
 * Under Reduce Motion the pulse stops and the bars hold at their mid value —
 * still legibly a placeholder, which a stopped spinner is not.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Radius, Space, useMotionOk, usePalette } from '@/theme';

/** One bar. `w` is a width — a percentage string or a dp number. */
export function Bar({ w = '100%', h = 14 }: { w?: DimensionValue; h?: number }) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const breath = useSharedValue(motionOk ? 0 : 0.5);

  useEffect(() => {
    if (!motionOk) return;
    breath.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(breath);
  }, [motionOk, breath]);

  const style = useAnimatedStyle(() => ({ opacity: 0.4 + breath.value * 0.35 }));

  return (
    <Animated.View
      style={[{ width: w, height: h, borderRadius: Radius.sm, backgroundColor: p.rule }, style]}
    />
  );
}

/**
 * The placeholder for the passport screen: the note, then its checks. Shaped like
 * the real thing so the arrival is a fill-in, not a re-layout.
 */
export function PassportSkeleton() {
  const p = usePalette();
  return (
    <View
      style={styles.wrap}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your passport"
    >
      <View style={[styles.note, { backgroundColor: p.rule }]} />
      <View style={styles.lines}>
        <Bar w="38%" h={11} />
        <Bar w="72%" h={20} />
      </View>
      <View style={styles.rows}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.row}>
            <View style={[styles.seal, { backgroundColor: p.rule }]} />
            <View style={styles.rowText}>
              <Bar w={`${64 - i * 6}%`} h={13} />
              <Bar w={`${44 - i * 4}%`} h={10} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A generic placeholder for a list of plates: consents, factors, history. */
export function ListSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  const p = usePalette();
  return (
    <View style={styles.rows} accessibilityRole="progressbar" accessibilityLabel={label}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.plate, { borderColor: p.rule }]}>
          <Bar w="52%" h={14} />
          <Bar w="100%" h={10} />
          <Bar w="76%" h={10} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.xxl },
  note: { height: 196, borderRadius: Radius.lg, opacity: 0.5 },
  lines: { gap: Space.sm },
  rows: { gap: Space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  seal: { width: 18, height: 18, borderRadius: Radius.pill, opacity: 0.5 },
  rowText: { flex: 1, gap: Space.sm },
  plate: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.sm,
  },
});
