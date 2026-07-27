/**
 * The waiting indicator.
 *
 * Not `ActivityIndicator`. The platform spinner is a soft-edged grey pinwheel that
 * belongs to iOS and Material, and it appeared 14 times in the incumbent app,
 * always tinted indigo — the one place a stock control was most visible against a
 * committed visual world.
 *
 * This is the note's own instrument: an engraved arc sweeping a full circle, in
 * whatever ink its context is using. Under Reduce Motion it stops turning and
 * holds as a static gapped ring, so a waiting state is still legible as waiting.
 */
import { useEffect } from 'react';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useMotionOk, usePalette } from '@/theme';

export function Spinner({
  size = 20,
  color,
  /** Announced to a screen reader. Say what is being waited on, not "loading". */
  label,
}: {
  size?: number;
  color?: string;
  label?: string;
}) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const turn = useSharedValue(0);
  const ink = color ?? p.latent;

  useEffect(() => {
    if (!motionOk) return;
    turn.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(turn);
  }, [motionOk, turn]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.value * 360}deg` }],
  }));

  const r = size / 2 - 1.5;
  const circumference = 2 * Math.PI * r;

  return (
    <Animated.View
      style={style}
      accessible={label != null}
      accessibilityRole={label != null ? 'progressbar' : undefined}
      accessibilityLabel={label}
    >
      <Svg width={size} height={size} aria-hidden={label == null}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={ink}
          strokeWidth={2}
          fill="none"
          // A 72% arc: enough ring to read as an instrument, enough gap to read
          // as turning.
          strokeDasharray={`${circumference * 0.72} ${circumference}`}
          strokeLinecap="butt"
        />
      </Svg>
    </Animated.View>
  );
}
