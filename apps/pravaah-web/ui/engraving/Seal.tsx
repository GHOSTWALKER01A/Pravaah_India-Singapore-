import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * The MyPravaah seal — the official mark.
 *
 * A guilloche rosette: nested geometric-lathe curves whose phase walks across
 * the stack, which is what fans them apart inside each petal and crosses them
 * at the valleys. It is the same class of figure a rose engine cuts into a
 * banknote plate, and there for the same reason — a curve defined by its
 * parameters cannot be redrawn freehand, so it authenticates the surface it
 * appears on. DESIGN.md's rule that guilloche is real geometry rather than a
 * raster texture applies to the mark most of all.
 *
 * ## Why this is generated here rather than importing the SVG
 *
 * `brand/` holds generated masters, and the display cut is 48KB of path data.
 * Inlining that would put it in the HTML of every page, and loading it as an
 * `<img>` would give up `currentColor` — which the mark needs, because it is
 * struck in the field colour on rag and in gold on the field. The generator is
 * sixty lines and deterministic, so server and client render identical markup.
 *
 * ## DELIBERATELY NOT `Guilloche`
 *
 * The two draw the same family of curve, and folding one into the other is the
 * obvious cleanup — do not. `Guilloche` is a decorative generator whose band
 * count and seed are dials a section may turn for ornament; this is a fixed
 * identity whose numbers are not anyone's to tune. Shared, retuning a corner
 * medallion would silently restrike the logo.
 *
 * The constants below are the ones in `brand/build.mjs`, which derives the SVG
 * masters and every app icon from them, and they are duplicated a third time in
 * `apps/pravaah-rn/src/components/ui/logo.tsx`. Change one, change all three —
 * `brand/README.md` records the geometry and how to verify it.
 */

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
 * seal. Stroke is a fraction of the box, so the mark scales as one object.
 */
const CUTS = {
  display: { rings: 11, twist: 1.4, stroke: 0.0029296875 },
  standard: { rings: 7, twist: 1.1, stroke: 0.0049 },
  small: { rings: 5, twist: 0.9, stroke: 0.0072 },
} as const;

export type SealCut = keyof typeof CUTS;

/**
 * The cut a rendered size resolves at. Boundaries measured, not guessed — and
 * chosen from the size the mark is SHOWN at, never the size of the viewBox.
 */
function cutFor(size: number): SealCut {
  return size >= 128 ? "display" : size >= 44 ? "standard" : "small";
}

/**
 * One ring, as cubic Béziers.
 *
 * r(t) = R + a·cos(p·t + φ), sampled per petal and joined with Hermite tangents
 * taken from the analytic derivative — so the curve passes exactly through
 * every knot and is smooth across all of them, rather than being a polyline
 * pretending to be a curve.
 */
function ringPath(
  centre: number,
  outerRadius: number,
  amplitude: number,
  phase: number,
  perPetal: number,
): string {
  const segments = PETALS * perPetal;
  const step = (Math.PI * 2) / segments;

  const at = (t: number) => {
    const angle = t + ROTATION;
    const r = outerRadius + amplitude * Math.cos(PETALS * t + phase);
    const dr = -amplitude * PETALS * Math.sin(PETALS * t + phase);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: centre + r * cos,
      y: centre + r * sin,
      dx: (dr * cos - r * sin) * (step / 3),
      dy: (dr * sin + r * cos) * (step / 3),
    };
  };

  const f = (value: number): string => value.toFixed(2);
  const start = at(0);
  let d = `M${f(start.x)} ${f(start.y)}`;
  let previous = start;

  for (let i = 1; i <= segments; i += 1) {
    // The last segment lands back on the start point exactly, or `Z` closes the
    // ring with a visible chord where the two ends missed each other.
    const point = i === segments ? start : at(i * step);
    d +=
      `C${f(previous.x + previous.dx)} ${f(previous.y + previous.dy)}` +
      ` ${f(point.x - point.dx)} ${f(point.y - point.dy)}` +
      ` ${f(point.x)} ${f(point.y)}`;
    previous = point;
  }

  return `${d}Z`;
}

/** The seal's rings, outermost first, drawn in a fixed 512 box. */
const BOX = 512;

function sealPaths(cut: SealCut): { d: readonly string[]; stroke: number } {
  const { rings, twist, stroke } = CUTS[cut];
  const centre = BOX / 2;
  const width = stroke * BOX;
  // The outer petal points are tangent to the box: the mark's optical size is
  // its declared size, so a caller never has to guess at the extra margin.
  const tip = centre - width / 2;

  return {
    stroke: width,
    d: Array.from({ length: rings }, (_, index) => {
      const k = index / Math.max(1, rings - 1);
      return ringPath(
        centre,
        tip * RADIUS * (1 - k * RADIUS_FALLOFF),
        tip * AMPLITUDE * (1 - k * AMPLITUDE_FALLOFF),
        (k * Math.PI * 2 * twist) / PETALS,
        10,
      );
    }),
  };
}

/**
 * Tone: the seal inherits `currentColor`, and the caller is expected to set it
 * to the decorative gold — `text-latent-line` — on the field, or to the field
 * colour on rag. DESIGN.md forbids the golds from carrying information, and the
 * mark is consistent with that rather than an exception to it: a logo is an
 * identity, never a control or a status, and it always appears beside the name
 * it stands for. WCAG 2.2 exempts logotypes from the contrast floor for the
 * same reason. If the seal is ever the only thing telling a user something, add
 * the words — do not change the ink.
 *
 * `decorative` is the normal case, because the mark almost always sits next to
 * the wordmark: the name is already in the accessibility tree, and announcing
 * the logo again is noise.
 */
export function Seal({
  size,
  cut,
  className,
  decorative = true,
}: {
  /** Rendered edge length in px. The cut is chosen from it. */
  size: number;
  /** Force a cut. Only for a surface whose apparent size differs from `size`. */
  cut?: SealCut;
  className?: string;
  decorative?: boolean;
}): ReactElement {
  const { d, stroke } = sealPaths(cut ?? cutFor(size));

  return (
    <svg
      viewBox={`0 0 ${BOX} ${BOX}`}
      width={size}
      height={size}
      // `block` matters: an SVG defaults to inline, which puts it on a line box
      // with a baseline gap that misaligns it against the wordmark beside it.
      className={cn("engraved block shrink-0", className)}
      focusable="false"
      {...(decorative
        ? { "aria-hidden": true as const }
        : { role: "img" as const, "aria-label": "MyPravaah" })}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinejoin="round"
      >
        {d.map((path, index) => (
          <path key={index} d={path} />
        ))}
      </g>
    </svg>
  );
}
