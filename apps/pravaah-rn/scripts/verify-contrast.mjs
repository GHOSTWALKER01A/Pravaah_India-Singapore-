/**
 * Reads the REAL palette out of src/theme/tokens.ts and checks every foreground /
 * ground pair the app actually renders, in both themes, against WCAG 2.2 AA.
 *
 * This exists because "it looks fine" is not a check, and because a palette with
 * two golds and a field colour that swaps roles between themes has several pairs
 * that are easy to get wrong and impossible to eyeball. DESIGN.md quotes the
 * numbers this prints.
 *
 *   node scripts/verify-contrast.mjs
 *
 * Exit code 1 if any pair fails, so it can gate a commit.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/theme/tokens.ts'), 'utf8');

/* ── Pull the palettes out of the TS source without a TS toolchain ─────────── */

function block(name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`cannot find const ${name}`);
  // Walk braces so nested objects and comments do not end the block early.
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(from, i);
}

function parse(name) {
  const out = {};
  for (const m of block(name).matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*'([^']+)'/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

const shared = parse('Shared');
const light = { ...shared, ...parse('light') };
const dark = { ...shared, ...parse('dark') };

const bandBlock = block('BAND_INK');
const bandsFor = (theme) => {
  const seg = bandBlock.slice(bandBlock.indexOf(`${theme}: {`));
  const end = seg.indexOf('}');
  const out = {};
  for (const m of seg.slice(0, end).matchAll(/([A-Z_]+)\s*:\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
};

/* ── Contrast ─────────────────────────────────────────────────────────────── */

const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** `#RRGGBB` → [r,g,b] in 0..255, or null. */
function rgb(hex) {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** `rgba(r, g, b, a)` → {rgb, a}, or null. */
function parseRgba(value) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(
    value.trim(),
  );
  if (!m) return null;
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * Composite a possibly-translucent colour over an opaque one.
 *
 * This exists because the three `*Wash` tokens are `rgba()` and are used as TEXT
 * GROUNDS by `Notice` and by the destructive button. The first version of this
 * script returned null for anything non-hex, so those pairs shipped unchecked
 * while DESIGN.md claimed "no pair ships unverified".
 */
function flatten(color, over) {
  const solid = rgb(color);
  if (solid) return solid;
  const t = parseRgba(color);
  const base = rgb(over);
  if (!t || !base) return null;
  return t.rgb.map((c, i) => c * t.a + base[i] * (1 - t.a));
}

function luminanceOf(channels) {
  const [r, g, b] = channels.map((c) => c / 255);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/**
 * Contrast between `fg` and `bg`.
 *
 * `under` is the opaque surface a translucent `bg` sits on — needed because a wash
 * is only meaningful once flattened against its ground.
 */
function ratio(fg, bg, under) {
  const flatBg = flatten(bg, under);
  if (!flatBg) return null;
  // A translucent foreground composites over its own (already flattened) ground.
  const flatFg = flatten(fg, `#${flatBg.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`);
  if (!flatFg) return null;
  const [a, b] = [luminanceOf(flatFg), luminanceOf(flatBg)];
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── The pairs the app actually renders ───────────────────────────────────── */

/** Grounds a given foreground is allowed to sit on, and the ratio it must clear. */
const PAIRS = [
  // Body + secondary text on every sheet ground.
  ['ink', ['ground', 'groundSunk', 'panel'], 4.5],
  ['inkDim', ['ground', 'groundSunk', 'panel'], 4.5],
  ['inkFaint', ['ground', 'groundSunk', 'panel'], 4.5], // microtext floor
  // The second colour, wherever a revocation or failure is stated.
  ['carmine', ['ground', 'groundSunk', 'panel'], 4.5],
  // Readable gold. `latentLine` is intentionally NOT here — see below.
  ['latent', ['ground', 'groundSunk', 'panel'], 4.5],
  // A cleared status mark.
  ['cleared', ['ground', 'groundSunk', 'panel'], 4.5],
  // Reversed out of the intaglio field.
  ['onField', ['field', 'fieldDeep', 'fieldMid'], 4.5],
  ['onFieldDim', ['field', 'fieldDeep'], 4.5],
  ['onFieldLatent', ['field', 'fieldDeep'], 4.5],
  ['onFieldCarmine', ['field', 'fieldDeep'], 4.5],
  /**
   * Keylines are graphics, not text: they only have to be perceptible.
   *
   * `rule` is for the SHEET. On the intaglio field the line has to be LIGHTER than
   * its ground, which is what `ruleOnField` is for — and in dark mode `panel` IS
   * the field, so `Panel`, `Field`, `Rule` and `VRule` all resolve to the field
   * keyline there via context. `panel` is therefore absent from `rule`'s grounds
   * because a sheet rule is genuinely never drawn on a plate — enforced in code
   * now, not merely asserted here, which is what the earlier version of this
   * comment got wrong while ten call sites drew a 1.01:1 line.
   */
  ['rule', ['ground'], 1.3],
  ['ruleStrong', ['ground'], 1.6],
  ['ruleOnField', ['field', 'panel'], 1.3],
  ['ruleOnFieldStrong', ['field', 'fieldDeep', 'ground'], 1.6],
];

/**
 * The washes, as the text grounds they actually are.
 *
 * `[wash token, foreground token, opaque surface underneath, required ratio]`.
 * Every combination `Notice` and the destructive `Button` can render.
 */
const WASH_PAIRS = [
  ['carmineWash', 'carmine', 'ground', 4.5],
  ['carmineWash', 'carmine', 'panel', 4.5],
  ['latentWash', 'latent', 'ground', 4.5],
  ['latentWash', 'latent', 'panel', 4.5],
  ['fieldWash', 'cleared', 'ground', 4.5],
  ['fieldWash', 'cleared', 'panel', 4.5],
  ['fieldWash', 'ink', 'ground', 4.5],
  ['latentWash', 'inkDim', 'ground', 4.5],
  ['carmineWash', 'inkDim', 'ground', 4.5],
];

const rows = [];
let failures = 0;

function check(theme, p, label, fg, bg, need, under) {
  const r = ratio(p[fg] ?? fg, p[bg] ?? bg, p[under ?? bg] ?? under ?? p[bg] ?? bg);
  if (r == null) return;
  const ok = r >= need;
  if (!ok) failures++;
  rows.push({
    theme,
    pair: `${label} on ${bg}`,
    fg: p[fg] ?? fg,
    bg: p[bg] ?? bg,
    r: r.toFixed(2),
    need: need.toFixed(1),
    ok,
  });
}

for (const [theme, p] of [
  ['light', light],
  ['dark', dark],
]) {
  for (const [fg, grounds, need] of PAIRS) {
    if (!(fg in p)) {
      console.error(`MISSING token: ${theme}.${fg}`);
      failures++;
      continue;
    }
    for (const bg of grounds) check(theme, p, fg, fg, bg, need);
  }
  // Score bands sit on the sheet ground and inside panels.
  for (const [band, hex] of Object.entries(bandsFor(theme))) {
    for (const bg of ['ground', 'panel']) check(theme, p, `band ${band}`, hex, bg, 4.5);
  }
  // Text on a translucent wash, flattened against the surface beneath it.
  for (const [wash, fg, under, need] of WASH_PAIRS) {
    check(theme, p, `${fg} on ${wash}/${under}`, fg, wash, need, under);
  }
  // The one pair that is allowed to be low, asserted as an UPPER bound so nobody
  // "fixes" it by promoting decorative gold into readable gold.
  const lineR = ratio(p.latentLine, p.ground, p.ground);
  const decorOk = theme === 'light' ? lineR < 3 : true;
  rows.push({
    theme,
    pair: 'latentLine on ground (DECOR ONLY)',
    fg: p.latentLine,
    bg: p.ground,
    r: lineR.toFixed(2),
    need: theme === 'light' ? '<3.0' : 'n/a',
    ok: decorOk,
  });
  if (!decorOk) failures++;
}

/* ── Report ───────────────────────────────────────────────────────────────── */

const w = (s, n) => String(s).padEnd(n);
let lastTheme = '';
for (const r of rows) {
  if (r.theme !== lastTheme) {
    console.log(`\n── ${r.theme.toUpperCase()} ${'─'.repeat(56)}`);
    lastTheme = r.theme;
  }
  console.log(
    `${r.ok ? '  ok ' : '  FAIL'} ${w(r.pair, 40)} ${w(r.fg, 9)} ${w(r.bg, 9)} ${w(r.r, 7)} need ${r.need}`,
  );
}

console.log(
  `\n${rows.length} pairs checked across both themes — ${failures} failure${failures === 1 ? '' : 's'}.`,
);
process.exit(failures ? 1 : 0);
