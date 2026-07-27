import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * Guilloche — machine-generated lathe work, the oldest anti-forgery device
 * there is. It resists forgery precisely because it is not drawn by hand: it
 * is traced by a formula, and a formula is what we generate here.
 *
 * The curve is a hypotrochoid (the spirograph family real guilloche machines
 * cut). Every parameter is deterministic, so the same `seed` always produces
 * the same rosette — server and client render identical markup, and a given
 * section keeps its identity across builds.
 */

function hypotrochoid(
  outerRadius: number,
  innerRadius: number,
  penOffset: number,
  turns: number,
  samples: number,
  size: number,
): string {
  const centre = size / 2;
  const ratio = (outerRadius - innerRadius) / innerRadius;
  const points: string[] = [];

  for (let i = 0; i <= samples; i += 1) {
    const t = (i / samples) * turns * Math.PI * 2;
    const x =
      centre +
      (outerRadius - innerRadius) * Math.cos(t) +
      penOffset * Math.cos(ratio * t);
    const y =
      centre +
      (outerRadius - innerRadius) * Math.sin(t) -
      penOffset * Math.sin(ratio * t);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  return `M${points.join("L")}Z`;
}

interface GuillocheProps {
  className?: string;
  /** Deterministic variation between rosettes. Same seed, same figure. */
  seed?: number;
  /** Concentric traces. More bands read as finer engraving, and cost more. */
  bands?: number;
  size?: number;
  strokeWidth?: number;
}

export function Guilloche({
  className,
  seed = 0,
  bands = 5,
  size = 400,
  strokeWidth = 0.6,
}: GuillocheProps): ReactElement {
  // Fixed lobe counts rather than a PRNG: a real lathe has discrete gear
  // teeth, and discrete values keep the figure from degenerating into mush.
  const lobes = [7, 9, 11, 13, 17][seed % 5];
  const traces = Array.from({ length: bands }, (_, band) => {
    const outerRadius = size / 2 - 6 - band * (size / 2 / (bands * 2.6));
    const innerRadius = outerRadius / lobes;
    const penOffset = innerRadius * (2.05 + band * 0.16);
    return hypotrochoid(outerRadius, innerRadius, penOffset, lobes, 1400, size);
  });

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={cn("pointer-events-none", className)}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
        {traces.map((d, index) => (
          <path key={index} d={d} opacity={0.85 - index * 0.11} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The engine-turned border a note runs along its edge — a repeating wave
 * rather than a closed rosette. Tiles horizontally at any width.
 */
export function GuillocheBand({
  className,
  height = 22,
  strokeWidth = 0.6,
}: {
  className?: string;
  height?: number;
  strokeWidth?: number;
}): ReactElement {
  const period = 48;
  const mid = height / 2;
  const amplitude = height / 2 - strokeWidth * 2;

  // Three phase-shifted waves interlacing, as a real engine-turned band does.
  const waves = [0, period / 3, (period * 2) / 3].map((phase) => {
    const segments: string[] = [];
    for (let x = 0; x <= period * 8; x += 2) {
      const y =
        mid +
        Math.sin(((x + phase) / period) * Math.PI * 2) * amplitude * 0.62 +
        Math.sin(((x + phase) / (period / 3)) * Math.PI * 2) * amplitude * 0.34;
      segments.push(`${x},${y.toFixed(2)}`);
    }
    return `M${segments.join("L")}`;
  });

  return (
    <svg
      viewBox={`0 0 ${period * 8} ${height}`}
      preserveAspectRatio="none"
      // `block` matters: an SVG defaults to inline, which puts it on a line box
      // with leading whitespace and a baseline gap — enough to push the sheet
      // a couple of pixels wider than the viewport.
      className={cn("pointer-events-none block w-full", className)}
      style={{ height }}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
        {waves.map((d, index) => (
          <path key={index} d={d} opacity={0.7 - index * 0.16} />
        ))}
      </g>
    </svg>
  );
}
