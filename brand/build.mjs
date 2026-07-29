/**
 * Builds every Pravaah seal asset from the one parameter block below.
 *
 * The seal is not a drawing — it is a geometric-lathe figure, the same class of
 * curve a rose engine cuts into a banknote plate. So it is DEFINED here as its
 * parameters and DERIVED into files, rather than being an .ai file someone once
 * exported. Change a number in SEAL, re-run, and every surface follows.
 *
 *   node brand/build.mjs          SVG masters only — zero dependencies
 *   node brand/build.mjs --png    also re-exports the app icons (needs `sharp`)
 *
 * The PNG step is opt-in because `sharp` is a native module and nothing else in
 * the repo needs it. The rasters it produces are committed, so a normal checkout
 * never has to run it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ────────────────────────────────────────────────────────────────────────────
   The mark
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every ring is r(t) = R + a·cos(p·t + φ) — a rosette, the figure a geometric
 * lathe traces when the cutting head rides an eccentric while the plate turns.
 *
 * Radii are fractions of TIP, the radius of the outermost petal point, so the
 * whole figure scales from a single number. The four ring parameters are what
 * make it read as engraving rather than as a flower outline:
 *
 *   RADIUS/AMPLITUDE  0.70 / 0.30 — the petal valley lands at exactly 0.4·TIP.
 *   RADIUS_FALLOFF    each ring sits further in, so the stack has depth at the
 *                     valleys instead of pinching to a single line there.
 *   AMPLITUDE_FALLOFF the waves flatten inward, so the core resolves to a
 *                     near-circle and the eye finds a centre.
 *   TWIST             the phase walks 1.4 petals across the stack. This is the
 *                     whole mark: it is what fans the rings apart inside each
 *                     petal and crosses them at the valleys, and it is why the
 *                     figure is chiral and cannot be drawn freehand.
 */
export const SEAL = {
  PETALS: 14,
  RADIUS: 0.7,
  AMPLITUDE: 0.3,
  RADIUS_FALLOFF: 0.35,
  AMPLITUDE_FALLOFF: 0.8,
  /** A petal point at 12 o'clock. PETALS is even, so one lands at 6 o'clock too. */
  ROTATION: -90,

  /**
   * Three CUTS of the one figure, the way a type family has an optical size.
   *
   * Eleven hairlines inside 40px is a smudge, so the mark thins its stack and
   * thickens its line as it shrinks. Only three numbers change — the petal
   * profile never does, so all three read as the same seal. The ranges are not
   * taste: each cut was rendered at 180, 87 and 40px and the boundaries put
   * every surface on the cut that still resolves there.
   *
   * A logo with no small cut does not have a small size, only a bad one.
   */
  CUTS: {
    /** ≥128px. Hero, print, the onboarding masthead. The full engraving. */
    display: { RINGS: 11, TWIST: 1.4, STROKE: 0.0029296875 },
    /** 44–128px. App icons, headers. Loses four rings, keeps the fan. */
    standard: { RINGS: 7, TWIST: 1.1, STROKE: 0.0049 },
    /** ≤44px. Favicon, themed launcher icon. Five rings, near-solid line. */
    small: { RINGS: 5, TWIST: 0.9, STROKE: 0.0072 },
  },
};

/** The cut a given rendered size resolves at. Sizes are in device-independent px. */
export function cutFor(px) {
  return px >= 128 ? 'display' : px >= 44 ? 'standard' : 'small';
}

/** Brand ink. Both values are existing tokens in `apps/pravaah-rn/src/theme/tokens.ts`. */
export const INK = {
  /** `latentLine` — the decorative gold. The seal is drawn in it and nothing else. */
  gold: '#B08434',
  /** `field` — the intaglio plate the seal is struck on. */
  field: '#0E3B2E',
  /** `ground` — security rag paper. */
  rag: '#EEEFE7',
};

/* ────────────────────────────────────────────────────────────────────────────
   Geometry
   ──────────────────────────────────────────────────────────────────────────── */

/** Position and velocity of one ring at parameter t. */
function ringAt(t, { cx, cy, R, a, p, phase, rot }) {
  const th = t + rot;
  const r = R + a * Math.cos(p * t + phase);
  const dr = -a * p * Math.sin(p * t + phase);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  return {
    x: cx + r * cos,
    y: cy + r * sin,
    dx: dr * cos - r * sin,
    dy: dr * sin + r * cos,
  };
}

/** The knot and its two Bézier handles for the segment starting at index i. */
function segment(ring, i, n, h) {
  const A = ringAt(i * h, ring);
  const B = ringAt((i + 1) * h, ring);
  return [
    [A.x + (h / 3) * A.dx, A.y + (h / 3) * A.dy],
    [B.x - (h / 3) * B.dx, B.y - (h / 3) * B.dy],
    [B.x, B.y],
  ];
}

/**
 * One ring as cubic Béziers.
 *
 * Sampled at `perPetal` points and joined with Hermite tangents taken from the
 * analytic derivative — so the curve is exact at every knot and C¹ everywhere,
 * rather than a polyline pretending to be smooth. {@link fitError} reports what
 * the approximation costs.
 *
 * Emitted RELATIVE, which roughly halves the file: a delta between adjacent
 * points needs two digits where an absolute coordinate needs five. The catch is
 * that rounded deltas accumulate drift, so each delta is measured from the
 * position a PARSER would be at — the running sum of deltas already emitted —
 * and never from the true curve. That keeps the reconstructed point within one
 * rounding of exact all the way around the ring instead of walking off it.
 */
function ringPath(ring, perPetal, dp) {
  const n = ring.p * perPetal;
  const h = (Math.PI * 2) / n;
  const r = (v) => Number(v.toFixed(dp));
  // Trim the leading zero of "0.42" and drop the separator before a "-".
  const s = (v) => String(v).replace(/^(-?)0\./, '$1.');
  const join = (nums) => nums.map(s).reduce((a, b) => a + (b.startsWith('-') ? '' : ' ') + b);

  const start = ringAt(0, ring);
  let cx = r(start.x);
  let cy = r(start.y);
  let d = `M${join([cx, cy])}c`;

  for (let i = 0; i < n; i++) {
    const seg = segment(ring, i, n, h);
    // The last segment must land exactly on the start point, or `Z` closes the
    // ring with a visible chord where the two ends missed each other.
    const end = i === n - 1 ? [start.x, start.y] : seg[2];
    const dxs = [seg[0][0] - cx, seg[1][0] - cx, end[0] - cx].map(r);
    const dys = [seg[0][1] - cy, seg[1][1] - cy, end[1] - cy].map(r);
    d += (i ? ' ' : '') + join([dxs[0], dys[0], dxs[1], dys[1], dxs[2], dys[2]]);
    cx = r(cx + dxs[2]);
    cy = r(cy + dys[2]);
  }
  return `${d}Z`;
}

/** Max distance between the fitted cubics and the true curve, in box units. */
/**
 * Re-parse an emitted path back into absolute cubics.
 *
 * Deliberately a parser over the STRING rather than a replay of the encoder's
 * arithmetic: it is the file that ships, so the file is what gets measured. A
 * mistake in the relative accumulator, or in the "drop the leading zero" number
 * formatting, surfaces here — replaying the encoder would only agree with
 * itself and prove nothing.
 */
function parsePath(d) {
  const nums = (d.match(/-?(?:\d*\.\d+|\d+)/g) ?? []).map(Number);
  let [x, y] = nums;
  const out = [];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    const seg = [
      [x, y],
      [x + nums[i], y + nums[i + 1]],
      [x + nums[i + 2], y + nums[i + 3]],
      [x + nums[i + 4], y + nums[i + 5]],
    ];
    out.push(seg);
    [x, y] = seg[3];
  }
  return out;
}

/** Max distance from the emitted path to the true rosette, in box units. */
function fitError(ring, perPetal, dp) {
  const segs = parsePath(ringPath(ring, perPetal, dp));
  const h = (Math.PI * 2) / segs.length;
  let max = 0;
  segs.forEach((c, i) => {
    for (let k = 0; k <= 24; k++) {
      const s = k / 24;
      const u = 1 - s;
      const w = [u * u * u, 3 * u * u * s, 3 * u * s * s, s * s * s];
      const bx = w.reduce((acc, wj, j) => acc + wj * c[j][0], 0);
      const by = w.reduce((acc, wj, j) => acc + wj * c[j][1], 0);
      // Nearest point on the true curve, searched in a window around the
      // parameter-matched sample — the geometric error, not a parametric one.
      let best = Infinity;
      for (let j = -16; j <= 16; j++) {
        const e = ringAt((i + s + j / 32) * h, ring);
        best = Math.min(best, Math.hypot(bx - e.x, by - e.y));
      }
      max = Math.max(max, best);
    }
  });
  return max;
}

/**
 * The rings of the seal, outermost first, in a `box`-sized square.
 *
 * `inset` shrinks the figure inside its box — used for the app icons, where the
 * mark must sit inside a platform safe area rather than bleed to the edge.
 */
export function rings({ box, cut: name = 'display', inset = 0 }) {
  const cut = { ...SEAL, ...SEAL.CUTS[name] };
  const c = box / 2;
  const stroke = cut.STROKE * box;
  // The outermost petal point is tangent to the box: the ink touches, so the
  // mark's optical size is its declared size and no consumer has to guess.
  const tip = c * (1 - inset) - stroke / 2;
  return {
    stroke,
    ring: Array.from({ length: cut.RINGS }, (_, i) => {
      const k = i / Math.max(1, cut.RINGS - 1);
      return {
        cx: c,
        cy: c,
        p: cut.PETALS,
        R: tip * cut.RADIUS * (1 - k * cut.RADIUS_FALLOFF),
        a: tip * cut.AMPLITUDE * (1 - k * cut.AMPLITUDE_FALLOFF),
        phase: (k * Math.PI * 2 * cut.TWIST) / cut.PETALS,
        rot: (cut.ROTATION * Math.PI) / 180,
      };
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Emit
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Cubic segments per petal, and coordinate precision.
 *
 * Chosen off the `--fit` table. The error that matters is the one measured
 * against STROKE WIDTH, not against the box, because that ratio is what stays
 * constant as the mark scales: 10 segments per petal holds the curve inside
 * 2.2% of a stroke width, which no rasteriser can resolve at any size. Going
 * further only grows the file — past 16 the error stops falling anyway, because
 * 2dp coordinate rounding becomes the floor.
 */
const PER_PETAL = 10;
const DP = 2;

function paths({ box, cut, inset }, attrs) {
  const { stroke, ring } = rings({ box, cut, inset });
  const d = ring.map((r) => ringPath(r, PER_PETAL, DP));
  return `  <g fill="none" stroke-width="${Number(stroke.toFixed(3))}" stroke-linejoin="round" ${attrs}>
${d.map((x) => `    <path d="${x}"/>`).join('\n')}
  </g>`;
}

function svg({ box, title, desc, body, bg }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${box}" height="${box}" role="img" aria-labelledby="${id}-t ${id}-d">
  <title id="${id}-t">${title}</title>
  <desc id="${id}-d">${desc}</desc>
${bg ? `  <rect width="${box}" height="${box}" fill="${bg}"/>\n` : ''}${body}
</svg>
`;
}

const desc = (cut) =>
  `A guilloche rosette: ${SEAL.CUTS[cut].RINGS} nested lathe curves of ${SEAL.PETALS} petals ` +
  `each, their phase walking ${SEAL.CUTS[cut].TWIST} petals across the stack.`;

/** iOS home-screen icons are ~68% mark; Android guarantees only the inner 66%. */
const IOS_INSET = 0.16;
const ANDROID_INSET = 0.34;

const FILES = {
  /** Master. One ink, currentColor, ink tangent to the box. Use this everywhere. */
  'brand/pravaah-seal.svg': svg({
    box: 512,
    title: 'Pravaah',
    desc: desc('display'),
    body: paths({ box: 512, cut: 'display' }, 'stroke="currentColor"'),
  }),
  /** The master in brand gold, for surfaces that cannot set `color`. */
  'brand/pravaah-seal-gold.svg': svg({
    box: 512,
    title: 'Pravaah',
    desc: desc('display'),
    body: paths({ box: 512, cut: 'display' }, `stroke="${INK.gold}"`),
  }),
  /** The 44–128px cut. */
  'brand/pravaah-seal-standard.svg': svg({
    box: 512,
    title: 'Pravaah',
    desc: desc('standard'),
    body: paths({ box: 512, cut: 'standard' }, 'stroke="currentColor"'),
  }),
  /** The ≤44px cut. */
  'brand/pravaah-seal-small.svg': svg({
    box: 512,
    title: 'Pravaah',
    desc: desc('small'),
    body: paths({ box: 512, cut: 'small' }, 'stroke="currentColor"'),
  }),
  /** App icon: the seal struck on the intaglio plate. */
  'brand/pravaah-icon.svg': svg({
    box: 1024,
    title: 'Pravaah app icon',
    desc: `${desc('standard')} Struck in gold on the intaglio field.`,
    bg: INK.field,
    body: paths({ box: 1024, cut: 'standard', inset: IOS_INSET }, `stroke="${INK.gold}"`),
  }),
  /** The same lockup on rag paper, for light print and letterhead. */
  'brand/pravaah-icon-rag.svg': svg({
    box: 1024,
    title: 'Pravaah icon on rag',
    desc: `${desc('standard')} Struck in gold on security rag paper.`,
    bg: INK.rag,
    body: paths({ box: 1024, cut: 'standard', inset: IOS_INSET }, `stroke="${INK.gold}"`),
  }),

  /**
   * The iOS Icon Composer layer. Transparent — the bundle's own `fill` supplies
   * the intaglio plate behind it, so the OS can render the two at different
   * depths for the parallax and the dark and clear appearances.
   */
  'apps/pravaah-rn/assets/expo.icon/Assets/pravaah-seal.svg': svg({
    box: 1024,
    title: 'Pravaah',
    desc: desc('standard'),
    body: paths({ box: 1024, cut: 'standard', inset: IOS_INSET }, `stroke="${INK.gold}"`),
  }),

  /** The admin console's tab icon. Next serves `app/icon.svg` as the favicon. */
  'apps/pravaah-admin/app/icon.svg': svg({
    box: 512,
    title: 'Pravaah',
    desc: desc('small'),
    body: paths({ box: 512, cut: 'small' }, `stroke="${INK.gold}"`),
  }),

  /** The admin sidebar mark, shown at 28px. */
  'apps/pravaah-admin/public/pravaah-seal.svg': svg({
    box: 512,
    title: 'Pravaah',
    desc: desc('small'),
    body: paths({ box: 512, cut: 'small' }, `stroke="${INK.gold}"`),
  }),
};

/**
 * Rasters, derived from the same geometry — never traced from an SVG by hand.
 *
 * `cut` follows the size the asset is SHOWN at, not the size of the file. A
 * 1024² themed launcher icon still lands at roughly 48dp on a home screen, so
 * it takes the small cut despite being a large PNG. Getting this backwards is
 * the usual way a mark turns to mush on a phone.
 */
const PNG = [
  { out: 'apps/pravaah-rn/assets/images/icon.png', box: 1024, bg: INK.field, ink: INK.gold, cut: 'standard', inset: IOS_INSET },
  { out: 'apps/pravaah-rn/assets/images/android-icon-foreground.png', box: 1024, ink: INK.gold, cut: 'standard', inset: ANDROID_INSET },
  { out: 'apps/pravaah-rn/assets/images/android-icon-background.png', box: 1024, bg: INK.field, blank: true },
  { out: 'apps/pravaah-rn/assets/images/android-icon-monochrome.png', box: 1024, ink: '#FFFFFF', cut: 'small', inset: ANDROID_INSET },
  { out: 'apps/pravaah-rn/assets/images/splash-icon.png', box: 512, ink: INK.gold, cut: 'standard' },
  { out: 'apps/pravaah-rn/assets/images/favicon.png', box: 128, ink: INK.gold, cut: 'small' },
];

function write(rel, contents) {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  console.log(`  ${rel}  ${(contents.length / 1024).toFixed(1)} kB`);
}

/** Worst deviation of any ring in `cut` from the true rosette, as a % of its stroke. */
function cutError(cut, perPetal) {
  const { ring, stroke } = rings({ box: 512, cut });
  const err = Math.max(...ring.map((r) => fitError(r, perPetal, DP)));
  return { err, pct: (err / stroke) * 100, stroke };
}

if (process.argv.includes('--fit')) {
  console.log('cubics/petal   max error (512 box)   % of stroke   display master');
  for (const n of [4, 6, 8, 10, 12, 16, 20]) {
    const { ring } = rings({ box: 512, cut: 'display' });
    const { err, pct } = cutError('display', n);
    const kB = ring.reduce((s, r) => s + ringPath(r, n, DP).length, 0) / 1024;
    console.log(
      `${String(n).padStart(9)}   ${err.toFixed(4).padStart(17)}   ` +
        `${pct.toFixed(2).padStart(11)}%   ${kB.toFixed(1).padStart(9)} kB`,
    );
  }
  process.exit(0);
}

// The build states its own accuracy. A brand asset that cannot say how far it
// is from its definition is a drawing, not a derivation.
for (const cut of Object.keys(SEAL.CUTS)) {
  const { err, pct } = cutError(cut, PER_PETAL);
  console.log(
    `${cut.padEnd(9)} ${String(SEAL.CUTS[cut].RINGS).padStart(2)} rings — ` +
      `fit ${err.toFixed(4)} units on a 512 box (${pct.toFixed(2)}% of a stroke width)`,
  );
}
console.log();

console.log('svg:');
for (const [rel, contents] of Object.entries(FILES)) write(rel, contents);

if (process.argv.includes('--png')) {
  const { createRequire } = await import('node:module');
  let sharp;
  try {
    sharp = createRequire(import.meta.url)('sharp');
  } catch {
    console.error('\n--png needs sharp:  npm i -D sharp -w .');
    process.exit(1);
  }
  console.log('\npng:');
  for (const spec of PNG) {
    const body = spec.blank
      ? ''
      : paths({ box: spec.box, cut: spec.cut, inset: spec.inset ?? 0 }, `stroke="${spec.ink}"`);
    const src = svg({
      box: spec.box,
      title: 'Pravaah',
      desc: spec.blank ? 'The intaglio field.' : desc(spec.cut),
      body,
      bg: spec.bg,
    });
    const abs = join(ROOT, spec.out);
    mkdirSync(dirname(abs), { recursive: true });
    // Rendered at 4x and reduced with a Lanczos filter: the mark is hairlines,
    // and a 1x rasteriser aliases them into dashes at icon sizes.
    await sharp(Buffer.from(src), { density: 288 })
      .resize(spec.box * 4, spec.box * 4)
      .resize(spec.box, spec.box, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(abs);
    console.log(`  ${spec.out}  ${spec.box}²`);
  }
}
