/**
 * The segmented control — "the perfect switch effect".
 *
 * What it replaces on the Reputation screen: two full-width buttons side by side,
 * the active one filled solid indigo and the inactive one a grey card. Two primary
 * buttons competing, no relationship between them, and the switch was an instant
 * colour swap with no motion at all.
 *
 * This is one plate with a travelling indicator: the selected segment's field
 * slides on a spring, the labels crossfade their tone, and a light haptic marks
 * the change. The indicator is measured from the real laid-out width, so it is
 * correct at any label length and in any language.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import {
  Hairline,
  HitSize,
  Motion,
  Radius,
  Space,
  useMotionOk,
  usePalette,
} from '@/theme';

import { haptic } from './haptics';
import { Icon, type IconName } from './icon';
import { Press } from './pressable';
import { Text } from './text';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  /** Announced as the group's purpose — "View" or "Score explanation". */
  label,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const [width, setWidth] = useState(0);

  const index = Math.max(
    0,
    segments.findIndex((s) => s.value === value),
  );
  const slot = width > 0 ? width / segments.length : 0;
  const x = useSharedValue(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  // Driven from the resolved index rather than from the tap, so a value changed
  // from outside animates too. In an effect, not in render: assigning to a shared
  // value during render is a side effect, and under the React Compiler (enabled in
  // app.json) a re-render can be skipped entirely, which would strand the
  // indicator behind the selection.
  const target = index * slot;
  useEffect(() => {
    if (slot <= 0) return;
    x.value = motionOk ? withSpring(target, Motion.slide) : withTiming(target, { duration: 0 });
  }, [target, slot, motionOk, x]);

  const indicator = useAnimatedStyle(() => ({
    width: slot,
    transform: [{ translateX: x.value }],
  }));

  return (
    <View
      onLayout={onLayout}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={[styles.track, { backgroundColor: p.groundSunk, borderColor: p.rule }]}
    >
      {slot > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.indicator, { backgroundColor: p.field }, indicator]}
        />
      ) : null}

      {segments.map((s) => {
        const on = s.value === value;
        return (
          <Press
            key={s.value}
            onPress={() => {
              if (on) return;
              haptic.select();
              onChange(s.value);
            }}
            depth="none"
            ink={false}
            ripple={false}
            radius={Radius.sm}
            style={styles.segment}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={s.label}
          >
            <View style={styles.segmentBody}>
              {s.icon ? (
                <Icon
                  name={s.icon}
                  size={16}
                  color={on ? p.onField : p.inkDim}
                  weight={on ? 1.7 : 1.4}
                />
              ) : null}
              <Text
                role="label"
                tone="inherit"
                numberOfLines={1}
                style={{ color: on ? p.onField : p.inkDim }}
              >
                {s.label}
              </Text>
            </View>
          </Press>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: Radius.md,
    borderWidth: Hairline.base,
    padding: Hairline.thick,
    position: 'relative',
  },
  indicator: {
    position: 'absolute',
    top: Hairline.thick,
    bottom: Hairline.thick,
    left: Hairline.thick,
    borderRadius: Radius.sm,
  },
  segment: { flex: 1 },
  segmentBody: {
    // 48dp inside the track. The track's own hairline padding sits outside this,
    // so the tappable body itself meets the floor.
    minHeight: HitSize,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.sm,
    paddingVertical: Space.sm,
  },
});
