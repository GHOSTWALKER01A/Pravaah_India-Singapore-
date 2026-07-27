/**
 * The consent gate's checkbox, and the choice radio.
 *
 * These carry the most legally and ethically loaded interaction in the product —
 * "I agree to share the data above" — so they get real affordance rather than the
 * incumbent's bare `<View>` with a border that turned indigo and drew a `✓`
 * character in it. Two specific failures that fixed:
 *
 *   - no `accessibilityRole="checkbox"` and no `checked` state, so a screen-reader
 *     user could not tell whether they had agreed;
 *   - the whole row was the target but nothing acknowledged the tap, so on a slow
 *     render it was unclear whether the agreement had registered.
 *
 * The mark now strikes on a spring, and the row reports its state.
 */
import { type ReactNode, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import {
  Hairline,
  Motion,
  Radius,
  Space,
  useMotionOk,
  usePalette,
} from '@/theme';

import { haptic } from './haptics';
import { Press } from './pressable';
import { Text } from './text';

const BOX = 24;

export function Checkbox({
  checked,
  onChange,
  children,
  /** The accessible name. Required: the visible copy is a sentence, not a label. */
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  label: string;
}) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const on = useSharedValue(checked ? 1 : 0);

  useEffect(() => {
    const to = checked ? 1 : 0;
    on.value = motionOk ? withSpring(to, Motion.strike) : to;
  }, [checked, motionOk, on]);

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: on.value > 0.5 ? p.field : 'transparent',
    borderColor: on.value > 0.5 ? p.field : p.ruleStrong,
  }));
  const markStyle = useAnimatedStyle(() => ({
    opacity: on.value,
    transform: [{ scale: 0.6 + on.value * 0.4 }],
  }));

  return (
    <Press
      onPress={() => {
        haptic.select();
        onChange(!checked);
      }}
      depth="none"
      radius={Radius.md}
      style={styles.row}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
    >
      <View style={styles.rowBody}>
        <Animated.View style={[styles.box, boxStyle]}>
          <Animated.View style={markStyle}>
            <Svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
              <Path
                d="M2 7.4 L5.4 10.6 L12 3.6"
                stroke={p.onField}
                strokeWidth={2.2}
                fill="none"
                strokeLinecap="square"
              />
            </Svg>
          </Animated.View>
        </Animated.View>
        <View style={styles.label}>{children}</View>
      </View>
    </Press>
  );
}

/**
 * A radio choice presented as a full plate, because in this app the thing being
 * chosen (a data-sharing purpose) needs a title, a description, and its
 * consequences visible at the moment of choosing — not a dot in a list.
 */
export function ChoicePlate({
  selected,
  onSelect,
  title,
  detail,
  children,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail?: string;
  children?: ReactNode;
  label?: string;
}) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const on = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    const to = selected ? 1 : 0;
    on.value = motionOk ? withSpring(to, Motion.slide) : to;
  }, [selected, motionOk, on]);

  const plate = useAnimatedStyle(() => ({
    borderColor: on.value > 0.5 ? p.field : p.rule,
    borderWidth: Hairline.base + on.value * (Hairline.thick - Hairline.base) * 2,
    backgroundColor: on.value > 0.5 ? p.fieldWash : p.panel,
  }));
  const dot = useAnimatedStyle(() => ({
    opacity: on.value,
    transform: [{ scale: 0.4 + on.value * 0.6 }],
  }));

  return (
    <Press
      onPress={() => {
        if (selected) return;
        haptic.select();
        onSelect();
      }}
      depth="subtle"
      radius={Radius.md}
      style={styles.plateOuter}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label ?? title}
    >
      <Animated.View style={[styles.plate, plate]}>
        <View style={styles.plateHead}>
          <View style={styles.plateText}>
            <Text role="title">{title}</Text>
            {detail ? (
              <Text role="bodySm" tone="dim">
                {detail}
              </Text>
            ) : null}
          </View>
          <View style={[styles.ring, { borderColor: selected ? p.field : p.ruleStrong }]}>
            <Animated.View style={[styles.dot, { backgroundColor: p.field }, dot]} />
          </View>
        </View>
        {children}
      </Animated.View>
    </Press>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: 'stretch' },
  rowBody: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    paddingVertical: Space.sm,
  },
  box: {
    width: BOX,
    height: BOX,
    borderRadius: Radius.sm,
    borderWidth: Hairline.thick,
    alignItems: 'center',
    justifyContent: 'center',
    // Optically aligns the box with the first line of a 21px-leading sentence.
    marginTop: 1,
  },
  label: { flex: 1 },

  plateOuter: { alignSelf: 'stretch' },
  plate: {
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.md,
  },
  plateHead: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  plateText: { flex: 1, gap: 2 },
  ring: {
    width: 22,
    height: 22,
    borderRadius: Radius.pill,
    borderWidth: Hairline.thick,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  dot: { width: 11, height: 11, borderRadius: Radius.pill },
});
