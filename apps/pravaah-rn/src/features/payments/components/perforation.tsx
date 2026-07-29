import { memo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { Hairline, usePalette } from '@/theme';

/**
 * The tear edge — the signature device of the payments surface.
 *
 * A cheque book's counterfoil is defined by one physical fact: the cheque was torn out and the
 * stub stayed behind. That perforated edge is what makes a stub a stub rather than a card, and
 * it is the whole reason this surface reads as a book of past instructions instead of a feed.
 *
 * Real geometry, not a dashed border. `borderStyle: 'dashed'` cannot produce a perforation:
 * it renders as line segments, whereas a perforation is a row of PUNCHED HOLES with the paper
 * between them — the holes are the negative space, and on the intaglio field they must show the
 * ground THROUGH the plate. Drawn as SVG circles for that reason, with the connecting score
 * line at a hairline so the eye reads "this was meant to come apart here".
 *
 * The width is measured with `onLayout` rather than assumed, per DESIGN.md: a guessed width
 * leaves either a clipped hole or a gap at the end, and both look like a rendering bug on the
 * one surface that must look manufactured.
 */
export type PerforationEdge = 'top' | 'bottom' | 'left';

interface PerforationProps {
  edge: PerforationEdge;
  /** True when the edge sits on the intaglio field, so the holes catch the light. */
  onField?: boolean;
  /** Hole spacing. 7 is the pitch of a real cheque-book perforation at this scale. */
  pitch?: number;
}

const HOLE_R = 1.15;

export const Perforation = memo(function Perforation({
  edge,
  onField = false,
  pitch = 7,
}: PerforationProps) {
  const p = usePalette();
  const [span, setSpan] = useState(0);

  const vertical = edge === 'left';
  const onMeasure = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const next = vertical ? height : width;
    // Only grow-or-change, never thrash: a fractional layout difference re-rendering the whole
    // hole row on every frame is a real cost on a mid-range Android.
    if (Math.abs(next - span) > 1) setSpan(next);
  };

  // On the field a punched hole reveals the ground beneath the plate; on rag it is an
  // impression, so it reads as the sunk tone. Never a hard-coded palette value — in dark mode
  // `panel` IS `field`, and a sheet-tinted hole would vanish.
  const hole = onField ? p.fieldDeep : p.groundSunk;
  const score = onField ? p.ruleOnField : p.rule;

  const count = span > 0 ? Math.floor((span - pitch) / pitch) : 0;
  const inset = span > 0 ? (span - count * pitch) / 2 : 0;

  return (
    <View
      onLayout={onMeasure}
      style={[vertical ? styles.vertical : styles.horizontal]}
      // Decorative geometry is hidden from assistive tech: a screen reader announcing
      // twenty-two holes is worse than announcing nothing.
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {span > 0 ? (
        <Svg
          width={vertical ? HOLE_R * 2 + 2 : span}
          height={vertical ? span : HOLE_R * 2 + 2}
        >
          <Line
            x1={vertical ? HOLE_R + 1 : 0}
            y1={vertical ? 0 : HOLE_R + 1}
            x2={vertical ? HOLE_R + 1 : span}
            y2={vertical ? span : HOLE_R + 1}
            stroke={score}
            strokeWidth={Hairline.thin}
            strokeDasharray="1 3"
          />
          {Array.from({ length: count }, (_, i) => (
            <Circle
              key={i}
              cx={vertical ? HOLE_R + 1 : inset + i * pitch + pitch / 2}
              cy={vertical ? inset + i * pitch + pitch / 2 : HOLE_R + 1}
              r={HOLE_R}
              fill={hole}
            />
          ))}
        </Svg>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  horizontal: { width: '100%', height: HOLE_R * 2 + 2 },
  // `alignSelf: stretch` rather than `flex: 1`: Yoga's `flex` is `flexBasis: 0`, which would
  // collapse this to zero height inside a row and the holes would never be measured.
  vertical: { width: HOLE_R * 2 + 2, alignSelf: 'stretch' },
});
