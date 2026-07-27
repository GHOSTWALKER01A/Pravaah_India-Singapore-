/**
 * Progress, as an engraved rule.
 *
 * The incumbent `ProgressBar` was a 6dp pill with a solid indigo fill, and
 * `FlowProgress` was a row of coloured pills — a stock progress bar in a world
 * whose whole vocabulary is line work.
 *
 * This is a hairline track with the impressed portion in gold, drawn on a real
 * baseline, and it animates to its value rather than snapping. It reports itself
 * as a progressbar with a human-readable value, which the pills never did.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Hairline, Motion, Radius, useMotionOk, usePalette } from '@/theme';

export function ProgressRule({
  /** 0..1. Clamped. */
  value,
  /** Track weight. The default is a rule; `thick` for the score's own axis. */
  weight = 'rule',
  /** Announced value, e.g. "3 of 6 steps done". Required — a bare % says nothing. */
  label,
  color,
}: {
  value: number;
  weight?: 'rule' | 'thick';
  label: string;
  color?: string;
}) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const [width, setWidth] = useState(0);
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const filled = useSharedValue(0);

  useEffect(() => {
    const to = pct * width;
    filled.value = motionOk
      ? withTiming(to, {
          duration: Motion.duration.base,
          easing: Easing.bezier(...Motion.out),
        })
      : to;
  }, [pct, width, motionOk, filled]);

  const fill = useAnimatedStyle(() => ({ width: filled.value }));
  const h = weight === 'thick' ? 6 : Hairline.thick + 1.5;

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { height: h, backgroundColor: p.rule }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100), text: label }}
      accessibilityLabel={label}
    >
      <Animated.View
        style={[styles.fill, { height: h, backgroundColor: color ?? p.latentLine }, fill]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', borderRadius: Radius.sm, overflow: 'hidden' },
  fill: { borderRadius: Radius.sm },
});
