/**
 * The press primitive.
 *
 * The incumbent app's ONLY press state, at every one of its call sites, was
 * `opacity: 0.6`. That is the same treatment it used for `disabled`, so a pressed
 * control and a dead control looked identical — and a fading control reads as
 * something switching off rather than something being pushed.
 *
 * What a press does here instead, all three at once:
 *
 *   scale     0.97 on a spring, so the release carries velocity from the finger
 *   ink       a hairline darkening (lightening under UV) laid over the surface —
 *             ink presses INTO paper, so the surface gets denser, not thinner
 *   ripple    on Android, the platform's own ripple, because a fluent Android
 *             user reads its absence as a broken control
 *
 * Everything honours Reduce Motion by skipping the scale and keeping the ink,
 * which means feedback survives even when animation does not.
 */
import { type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { HitSize, Motion, Radius, useMotionOk, usePalette } from '@/theme';

import { haptic } from './haptics';

export interface PressProps extends Omit<PressableProps, 'style' | 'children'> {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** How far it presses. `none` for a whole-screen row where scaling looks odd. */
  depth?: 'none' | 'subtle' | 'full';
  /** Corner radius of the press overlay, so it never bleeds past the surface. */
  radius?: number;
  /** Which haptic to fire on a successful press. Most controls fire none. */
  feedback?: keyof typeof haptic | 'none';
  /** Draw the darkening overlay. Off for controls that already change colour. */
  ink?: boolean;
  /** Android ripple. Off inside a scroll row that already has its own. */
  ripple?: boolean;
}

const SCALE = { none: 1, subtle: 0.985, full: 0.97 } as const;

export function Press({
  children,
  style,
  depth = 'full',
  radius = Radius.md,
  feedback = 'none',
  ink = true,
  ripple = true,
  disabled,
  onPress,
  ...rest
}: PressProps) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const held = useSharedValue(0);

  const animated = useAnimatedStyle(() => {
    const target = 1 - (1 - SCALE[depth]) * held.value;
    return { transform: [{ scale: motionOk ? target : 1 }] };
  });

  const overlay = useAnimatedStyle(() => ({ opacity: held.value }));

  const handlePress: NonNullable<PressableProps['onPress']> = (event) => {
    if (feedback !== 'none') haptic[feedback]();
    onPress?.(event);
  };

  return (
    <Animated.View style={[animated, style]}>
      <Pressable
        disabled={disabled}
        onPress={handlePress}
        onPressIn={() => {
          held.value = withSpring(1, Motion.press);
        }}
        onPressOut={() => {
          held.value = withSpring(0, Motion.press);
        }}
        android_ripple={
          ripple && !disabled
            ? { color: p.ripple, foreground: true, borderless: false }
            : undefined
        }
        // A control must be reachable by a thumb before it is beautiful.
        hitSlop={8}
        // Deliberately no `flex: 1` here. The Animated.View owns the layout box
        // (it carries `style`); the Pressable stretches to it via the default
        // `align-items: stretch` and otherwise sizes to its content. Adding flex
        // makes a Press inside a row collapse to zero width.
        {...rest}
      >
        {children}
        {ink && !disabled ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: p.press, borderRadius: radius },
              overlay,
              // Android already draws a ripple; stacking a wash on top of it
              // double-darkens and looks like a rendering bug.
              Platform.OS === 'android' && ripple ? styles.hidden : null,
            ]}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/**
 * A press target that guarantees the 48dp minimum without forcing its visible
 * content to be 48dp tall. For icon-only controls: a 20dp glyph with 14dp of
 * invisible target around it.
 */
export function IconPress({
  children,
  size = HitSize,
  label,
  ...rest
}: Omit<PressProps, 'children' | 'style'> & {
  children: ReactNode;
  size?: number;
  label: string;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      radius={Radius.pill}
      {...rest}
    >
      <View style={[styles.center, { width: size, height: size }]}>{children}</View>
    </Press>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  hidden: { opacity: 0 },
});
