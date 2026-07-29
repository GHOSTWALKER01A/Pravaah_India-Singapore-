import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { Radius, usePalette } from '@/theme';

import { QrTooLongError, encodeQr } from '../qr';

type Encoded = ReturnType<typeof encodeQr>;

/**
 * Encode, or report "too long" as an absence.
 *
 * A payload that overflows version 10 is a server-side problem, not a render-time crash, so the
 * component degrades to a stated absence and the screen still works.
 *
 * Module scope, not a `useMemo` inside the component, and that is a correctness fix rather than a
 * style change: the component early-returns when this is null, and the path builder below used to
 * be a SECOND `useMemo` sitting AFTER that return. A payload changing from too-long to valid
 * therefore changed the number of hooks between renders — the "Rendered more hooks than during
 * the previous render" crash, and a Rules of React violation that also puts the whole component
 * at risk of a React Compiler bail-out. With both computations at module scope there are no
 * hooks after the branch, and the compiler memoises the calls for us.
 */
function encodeOrNull(payload: string): Encoded | null {
  try {
    return encodeQr(payload);
  } catch (error) {
    if (error instanceof QrTooLongError) return null;
    throw error;
  }
}

/** `h1v1h-1z` per module is the shortest form that closes each square. */
function modulePath(encoded: Encoded): string {
  const parts: string[] = [];
  for (let r = 0; r < encoded.size; r++) {
    const row = encoded.modules[r]!;
    for (let c = 0; c < encoded.size; c++) {
      if (row[c]) parts.push(`M${c + QUIET} ${r + QUIET}h1v1h-1z`);
    }
  }
  return parts.join('');
}

/**
 * A QR code, drawn as real generated geometry.
 *
 * One `<Path>` for every dark module in the matrix, emitted as a single path string rather than
 * ~1,700 `<Rect>` elements. That is not micro-optimisation: a version-9 code is 53×53, and half of
 * those as individual SVG nodes is a real cost on the mid-range Android this app is built for —
 * enough to drop frames while the screen mounts.
 *
 * The quiet zone is drawn, not assumed. The specification requires four modules of light margin,
 * and a code rendered flush to its container is one that scanners struggle with on a busy shopfront
 * — the margin is part of the code, not padding around it.
 *
 * On the intaglio field the polarity INVERTS: light modules are drawn as the paper and the dark
 * modules are the field showing through, because a black-on-green code has nowhere near the
 * contrast a scanner needs. So the plate gets a light panel behind the code, and the code is drawn
 * dark on that. This is the one place the design system's "field owns the region" rule yields, and
 * it yields to a functional requirement rather than to taste.
 */
interface QrMatrixProps {
  payload: string;
  /** Rendered edge length in dp, including the quiet zone. */
  size?: number;
  /** True when the code sits on the intaglio plate. */
  onField?: boolean;
  /**
   * Fixed polarity, overriding the theme.
   *
   * Needed because the themed colours INVERT under UV: `ground` is near-black in dark mode
   * and `ink` is near-white, so a code drawn from the palette comes out light-on-dark. A
   * human reads that as the same code; most scanners do not decode it at all, and the ones
   * that do are the exception rather than the guarantee. Any code a stranger will point a
   * camera at — the passport's verify code, a printed card — must pin its own light ground
   * and dark modules, because polarity is a scanning requirement and not a style choice.
   *
   * Left unset for a code inside the app's own screens, where the theme should win.
   */
  light?: string;
  dark?: string;
  /**
   * What a screen reader announces. A code is NOT decorative — a screen-reader user needs
   * to know one is present and that its address is available as text nearby.
   */
  label?: string;
}

/** Four modules, as the specification requires. */
const QUIET = 4;

export const QrMatrix = memo(function QrMatrix({
  payload,
  size = 200,
  onField = false,
  light,
  dark,
  label = 'QR code for your UPI ID. The address is written below it as text.',
}: QrMatrixProps) {
  const p = usePalette();

  const encoded = encodeOrNull(payload);

  if (!encoded) {
    return (
      <View
        style={[
          styles.fallback,
          { width: size, height: size, borderColor: onField ? p.ruleOnField : p.rule },
        ]}
      />
    );
  }

  const span = encoded.size + QUIET * 2;

  const path = modulePath(encoded);

  return (
    <View
      // The code is one object to assistive tech, and it is NOT decorative: a screen-reader user
      // needs to know a code is present and that the address is available as text beside it.
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${span} ${span}`}>
        {/*
          The light ground, including the quiet zone. Always drawn — a transparent QR over a dark
          plate is unscannable, and on rag it guarantees the margin is the paper tone rather than
          whatever container it lands in.
        */}
        <Rect
          x={0}
          y={0}
          width={span}
          height={span}
          fill={light ?? (onField ? p.ground : p.panel)}
          rx={onField ? 1 : 0}
        />
        <Path d={path} fill={dark ?? p.ink} />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  fallback: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Radius.md,
  },
});
