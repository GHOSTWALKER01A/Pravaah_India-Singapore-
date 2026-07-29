/**
 * Guilloche — real generated lathe-work geometry.
 *
 * DESIGN.md's rule: guilloche is real geometry, never a raster texture. So these
 * are the actual parametric curves a geometric lathe traces, evaluated at render
 * and emitted as SVG paths:
 *
 *   rosette   r(t) = R + a·cos(p·t)        — the petal count `p` is what makes a
 *                                            rosette impossible to redraw by hand,
 *                                            which is the whole point of putting it
 *                                            on a security document.
 *   band      y(x) = Σ Aᵢ·sin(ωᵢx + φᵢ)    — superposed sinusoids; the moiré comes
 *                                            from stacking phase-shifted copies.
 *
 * Both are deterministic functions of their props. No randomness: the same note
 * must engrave identically on every launch, and a rosette that reshuffles itself
 * on re-render is a decoration, not a security feature.
 *
 * These are decorative by definition, so they draw in `latentLine` — the gold that
 * is not allowed to carry information — and are hidden from the accessibility tree.
 */
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { usePalette } from '@/theme';

/* ────────────────────────────────────────────────────────────────────────────
   Rosette
   ──────────────────────────────────────────────────────────────────────────── */

function rosettePath(
  cx: number,
  cy: number,
  radius: number,
  petals: number,
  amplitude: number,
  phase: number,
  steps: number,
): string {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = radius + amplitude * Math.cos(petals * t + phase);
    const x = cx + r * Math.cos(t);
    const y = cy + r * Math.sin(t);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    if (i < steps) d += ' ';
  }
  return `${d} Z`;
}

export interface RosetteProps {
  size: number;
  /**
   * Number of nested rings. Each is drawn at a slightly smaller radius and a
   * rotated phase, which is what produces the interference the eye reads as
   * engraving rather than as a flower outline.
   */
  rings?: number;
  petals?: number;
  color?: string;
  opacity?: number;
  strokeWidth?: number;
}

/**
 * The nested rosette rings.
 *
 * Module scope rather than a `useMemo` in the component: it is a pure function of its three
 * arguments, so the React Compiler memoises the call on exactly the dependencies the removed
 * `useMemo` listed — and out here the geometry is testable without rendering anything.
 */
function rosettePaths(size: number, rings: number, petals: number): string[] {
  const c = size / 2;
  // Leave room for the amplitude so the outermost petal tip does not clip.
  const outer = c * 0.78;
  const amp = c * 0.16;
  // 4 samples per petal is the floor at which the curve stops looking faceted.
  const steps = Math.max(160, petals * 22);
  return Array.from({ length: rings }, (_, i) => {
    const k = i / Math.max(1, rings - 1);
    return rosettePath(
      c,
      c,
      outer * (1 - k * 0.42),
      petals,
      amp * (1 - k * 0.35),
      // A phase walk of less than a full petal keeps the rings interfering
      // instead of stacking into one thick outline.
      (k * Math.PI * 2) / petals,
      steps,
    );
  });
}

export const Rosette = memo(function Rosette({
  size,
  rings = 7,
  petals = 11,
  color,
  opacity = 0.5,
  strokeWidth = 0.6,
}: RosetteProps) {
  const p = usePalette();
  const stroke = color ?? p.latentLine;

  const paths = rosettePaths(size, rings, petals);

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {paths.map((d, i) => (
        <Path
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth={strokeWidth}
          fill="none"
          // Inner rings fade, so the medallion has a centre rather than reading
          // as a flat stack of equal lines.
          opacity={opacity * (1 - (i / paths.length) * 0.45)}
        />
      ))}
    </Svg>
  );
});

/* ────────────────────────────────────────────────────────────────────────────
   Band
   ──────────────────────────────────────────────────────────────────────────── */

function bandPath(
  width: number,
  mid: number,
  waves: { amp: number; freq: number; phase: number }[],
  steps: number,
): string {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    let y = mid;
    for (const w of waves) {
      y += w.amp * Math.sin((x / width) * Math.PI * 2 * w.freq + w.phase);
    }
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    if (i < steps) d += ' ';
  }
  return d;
}

export interface BandProps {
  width: number;
  height: number;
  /** Number of phase-shifted copies. The moiré lives in this count. */
  lines?: number;
  color?: string;
  opacity?: number;
  strokeWidth?: number;
}

/** The phase-shifted copies whose interference is the moiré. Pure; see {@link rosettePaths}. */
function bandPaths(width: number, height: number, lines: number): string[] {
  if (width <= 0) return [];
  const steps = Math.max(120, Math.round(width / 2));
  const a = height * 0.17;
  return Array.from({ length: lines }, (_, i) => {
    const k = i / Math.max(1, lines - 1);
    // Three incommensurable frequencies: their least common period is longer
    // than the band, so the pattern never visibly repeats across its width.
    return bandPath(
      width,
      height / 2 + (k - 0.5) * height * 0.5,
      [
        { amp: a, freq: 3, phase: k * Math.PI * 2 },
        { amp: a * 0.62, freq: 7, phase: k * Math.PI * 1.3 },
        { amp: a * 0.34, freq: 13, phase: k * Math.PI * 0.7 },
      ],
      steps,
    );
  });
}

/**
 * The interference band that runs along an edge of the note. Used on the passport
 * base and as the divider under a field region.
 */
export const GuillocheBand = memo(function GuillocheBand({
  width,
  height,
  lines = 9,
  color,
  opacity = 0.42,
  strokeWidth = 0.6,
}: BandProps) {
  const p = usePalette();
  const stroke = color ?? p.latentLine;

  const paths = bandPaths(width, height, lines);

  if (!paths.length) return null;

  return (
    <Svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {paths.map((d, i) => (
        <Path key={i} d={d} stroke={stroke} strokeWidth={strokeWidth} fill="none" opacity={opacity} />
      ))}
    </Svg>
  );
});

/**
 * A rosette positioned as a corner medallion, clipped by its parent's overflow.
 *
 * Placed absolutely so it never affects layout — the note's composition is set by
 * its content, and the medallion sits behind it.
 */
export function CornerMedallion({
  size,
  top,
  right,
  color,
  opacity,
}: {
  size: number;
  top: number;
  right: number;
  color?: string;
  opacity?: number;
}) {
  return (
    <View style={[StyleSheet.absoluteFill, { alignItems: 'flex-end' }]} pointerEvents="none">
      <View style={{ marginTop: top, marginRight: right }}>
        <Rosette size={size} color={color} opacity={opacity} />
      </View>
    </View>
  );
}
