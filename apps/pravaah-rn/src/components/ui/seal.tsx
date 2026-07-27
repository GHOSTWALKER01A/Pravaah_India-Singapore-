/**
 * The seal — how a status looks on a security document.
 *
 * Four distinct SHAPES, not four colours. DESIGN.md's rule is that status is never
 * carried by colour alone, and this is where that is enforced: the mark differs in
 * geometry, so it survives greyscale printing, deuteranopia, and a 12dp render.
 *
 *   filled  — cleared. The seal is struck: a solid disc with the mark reversed out.
 *   open    — in flight, or awaiting a person. Ring plus a rotating index; the only
 *             shape that ever animates, and only while genuinely in flight.
 *   struck  — refused or withdrawn. Ring crossed through.
 *   hollow  — not attempted, or lapsed. A dashed ring, drawn but never impressed.
 */
import { memo, useEffect } from 'react';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useMotionOk } from '@/theme';
import type { SealShape } from '@/theme';

export interface SealProps {
  shape: SealShape;
  size?: number;
  color: string;
  /**
   * The colour the mark is reversed out in, for `filled`. Must be the surface the
   * seal sits on, so the mark reads as a hole punched in the disc.
   */
  voidColor: string;
  /**
   * Animate the `open` index. Only pass true when something is actually happening
   * — a spinner on a status that is merely awaiting a human reviewer is a lie
   * about the system doing work.
   */
  live?: boolean;
}

const GRID = 24;

export const Seal = memo(function Seal({
  shape,
  size = 18,
  color,
  voidColor,
  live = false,
}: SealProps) {
  const motionOk = useMotionOk();
  const spin = useSharedValue(0);
  const spinning = live && shape === 'open' && motionOk;

  useEffect(() => {
    if (!spinning) {
      cancelAnimation(spin);
      spin.value = 0;
      return;
    }
    spin.value = withRepeat(
      // Linear, because a rotating index on an instrument does not ease.
      withTiming(1, { duration: 2600, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(spin);
  }, [spinning, spin]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));

  const stroke = {
    stroke: color,
    strokeWidth: 1.6,
    fill: 'none',
    strokeLinecap: 'square' as const,
  };

  const body = (
    <Svg width={size} height={size} viewBox={`0 0 ${GRID} ${GRID}`} aria-hidden>
      {shape === 'filled' ? (
        <>
          <Circle cx={12} cy={12} r={10.4} fill={color} />
          <Path
            d="M7 12.4 L10.4 15.8 L17 8.6"
            stroke={voidColor}
            strokeWidth={2.2}
            fill="none"
            strokeLinecap="square"
          />
        </>
      ) : null}

      {shape === 'open' ? (
        <G {...stroke}>
          {/* A ring with a gap at the top: the seal is drawn but not closed. */}
          <Path d="M12 1.6 A10.4 10.4 0 1 1 11.9 1.6" strokeDasharray="52 13" />
          {/* The index that turns while work is in flight. */}
          <Line x1={12} y1={12} x2={12} y2={5.6} strokeWidth={2} />
          <Circle cx={12} cy={12} r={1.5} fill={color} strokeWidth={0} />
        </G>
      ) : null}

      {shape === 'struck' ? (
        <G {...stroke}>
          <Circle cx={12} cy={12} r={10.4} />
          <Line x1={7.4} y1={7.4} x2={16.6} y2={16.6} strokeWidth={2} />
          <Line x1={16.6} y1={7.4} x2={7.4} y2={16.6} strokeWidth={2} />
        </G>
      ) : null}

      {shape === 'hollow' ? (
        <G {...stroke}>
          <Circle cx={12} cy={12} r={10.4} strokeDasharray="3 3.2" strokeWidth={1.4} />
        </G>
      ) : null}
    </Svg>
  );

  // Only the live index rotates. Wrapping the static shapes in an Animated.View
  // would cost a node on every row of every list for no reason.
  if (!spinning) return body;
  return <Animated.View style={style}>{body}</Animated.View>;
});
