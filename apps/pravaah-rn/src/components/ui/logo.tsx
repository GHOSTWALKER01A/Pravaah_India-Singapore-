/**
 * The Pravaah seal — the official mark.
 *
 * A guilloche rosette: nested geometric-lathe curves whose phase walks across
 * the stack, which is what fans them apart inside each petal and crosses them
 * at the valleys. It is the same class of figure a rose engine cuts into a
 * banknote plate, and the same reason it is there — a curve defined by its
 * parameters cannot be redrawn by hand, so it authenticates the surface it
 * appears on. DESIGN.md's rule that guilloche is real geometry rather than a
 * raster texture applies to the mark most of all.
 *
 * DELIBERATELY NOT `Rosette`. The two draw the same family of curve, and
 * folding one into the other is the obvious cleanup — do not. `Rosette` is a
 * decorative generator whose petal count and ring count are dials a screen may
 * turn for ornament; this is a fixed identity whose numbers are not anyone's to
 * tune. If they shared an implementation, retuning a corner medallion would
 * silently restrike the logo.
 *
 * The constants below are the same ones in `brand/build.mjs`, which derives the
 * SVG masters and every app icon from them. They are duplicated because this
 * app cannot import from outside its own tree; if you change one, change both —
 * `brand/README.md` records the geometry and how to verify it.
 */
import { memo } from 'react';
import Svg, { G, Path } from 'react-native-svg';

import { usePalette } from '@/theme';

/* ────────────────────────────────────────────────────────────────────────────
   The mark
   ──────────────────────────────────────────────────────────────────────────── */

const PETALS = 14;
/** Fractions of the outermost petal-tip radius. The valley lands at 0.4 exactly. */
const RADIUS = 0.7;
const AMPLITUDE = 0.3;
/** Each ring sits further in, so the stack keeps depth at the valleys. */
const RADIUS_FALLOFF = 0.35;
/** The waves flatten inward, so the core resolves to a near-circle. */
const AMPLITUDE_FALLOFF = 0.8;
/** A petal point at 12 o'clock. PETALS is even, so one lands at 6 o'clock too. */
const ROTATION = -Math.PI / 2;

/**
 * Three cuts of the one figure, the way a type family has an optical size.
 *
 * Eleven hairlines inside 40px is a smudge, so the mark thins its stack and
 * thickens its line as it shrinks. Only the ring count, the phase walk and the
 * weight change — the petal profile never does, so all three read as the same
 * seal. STROKE is a fraction of `size`, so the mark scales as one object.
 */
const CUTS = {
  display: { rings: 11, twist: 1.4, stroke: 0.0029296875 },
  standard: { rings: 7, twist: 1.1, stroke: 0.0049 },
  small: { rings: 5, twist: 0.9, stroke: 0.0072 },
} as const;

export type LogoCut = keyof typeof CUTS;

/** The cut a rendered size resolves at. Boundaries measured, not guessed. */
function cutFor(size: number): LogoCut {
  return size >= 128 ? 'display' : size >= 44 ? 'standard' : 'small';
}

/* ────────────────────────────────────────────────────────────────────────────
   Geometry
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * One ring, as cubic Béziers.
 *
 * r(t) = R + a·cos(p·t + φ), sampled per petal and joined with Hermite tangents
 * taken from the analytic derivative — so the curve passes exactly through
 * every knot and is smooth across all of them, rather than being a polyline
 * pretending to be a curve. Ten segments per petal holds it inside 2% of a
 * stroke width of the true rosette, which is below what a screen can show.
 */
function ringPath(c: number, R: number, a: number, phase: number, perPetal: number): string {
  const n = PETALS * perPetal;
  const h = (Math.PI * 2) / n;

  const at = (t: number) => {
    const th = t + ROTATION;
    const r = R + a * Math.cos(PETALS * t + phase);
    const dr = -a * PETALS * Math.sin(PETALS * t + phase);
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    return {
      x: c + r * cos,
      y: c + r * sin,
      dx: (dr * cos - r * sin) * (h / 3),
      dy: (dr * sin + r * cos) * (h / 3),
    };
  };

  const f = (v: number) => v.toFixed(2);
  const start = at(0);
  let d = `M${f(start.x)} ${f(start.y)}`;
  let p0 = start;
  for (let i = 1; i <= n; i++) {
    // The last segment lands back on the start point exactly, or `Z` closes the
    // ring with a visible chord where the two ends missed each other.
    const p1 = i === n ? start : at(i * h);
    d +=
      `C${f(p0.x + p0.dx)} ${f(p0.y + p0.dy)}` +
      ` ${f(p1.x - p1.dx)} ${f(p1.y - p1.dy)}` +
      ` ${f(p1.x)} ${f(p1.y)}`;
    p0 = p1;
  }
  return `${d}Z`;
}

/**
 * The seal's rings, outermost first.
 *
 * Module scope rather than a `useMemo`: it is a pure function of its two
 * arguments, so the React Compiler memoises the call on exactly the
 * dependencies a `useMemo` would have listed — and out here the geometry is
 * testable without rendering anything.
 */
function sealPaths(size: number, cut: LogoCut): { d: string[]; stroke: number } {
  const { rings, twist, stroke } = CUTS[cut];
  const c = size / 2;
  const width = stroke * size;
  // The outer petal points are tangent to the box: the mark's optical size is
  // its declared size, so a caller never has to guess at the extra margin.
  const tip = c - width / 2;
  return {
    stroke: width,
    d: Array.from({ length: rings }, (_, i) => {
      const k = i / Math.max(1, rings - 1);
      return ringPath(
        c,
        tip * RADIUS * (1 - k * RADIUS_FALLOFF),
        tip * AMPLITUDE * (1 - k * AMPLITUDE_FALLOFF),
        (k * Math.PI * 2 * twist) / PETALS,
        // Fewer segments when the mark is small: at 32dp the extra precision is
        // far below a device pixel and only costs a longer path string.
        size >= 96 ? 10 : 6,
      );
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Component
   ──────────────────────────────────────────────────────────────────────────── */

export interface LogoProps {
  /** Rendered edge length in dp. The cut is chosen from it. */
  size: number;
  /** Force a cut. Only for a surface whose apparent size differs from `size`. */
  cut?: LogoCut;
  /** Defaults to the decorative gold — see the note on tone below. */
  color?: string;
  opacity?: number;
  /**
   * The mark alongside the word "Pravaah", which is the usual case: the name is
   * already in the accessibility tree, so announcing the logo again is noise.
   */
  decorative?: boolean;
}

/**
 * Tone: the seal draws in `latentLine`, the gold that DESIGN.md forbids from
 * carrying information. That is correct rather than a loophole — the mark is an
 * identity, never a control or a status, and it always appears beside the name
 * it stands for. WCAG 1.4.11 exempts logotypes from the contrast floor for the
 * same reason. If you ever find the seal being the only thing telling a user
 * something, the fix is to add the words, not to change the ink.
 */
export const Logo = memo(function Logo({
  size,
  cut,
  color,
  opacity,
  decorative = false,
}: LogoProps) {
  const p = usePalette();
  const { d, stroke } = sealPaths(size, cut ?? cutFor(size));

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      opacity={opacity}
      pointerEvents="none"
      {...(decorative
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }
        : { accessibilityRole: 'image' as const, accessibilityLabel: 'Pravaah' })}
    >
      <G fill="none" stroke={color ?? p.latentLine} strokeWidth={stroke} strokeLinejoin="round">
        {d.map((path, i) => (
          <Path key={i} d={path} />
        ))}
      </G>
    </Svg>
  );
});
