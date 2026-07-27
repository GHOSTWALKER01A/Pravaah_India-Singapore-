/**
 * THESIS: A reputation passport is state-issued trust made portable, so the app is
 * not a dashboard that reports a status — it is the note itself, in the holder's
 * hand. It refuses the arrangement it inherited: one 24pt-gap column of identical
 * filled cards, an indigo accent, and emoji for icons, on all 22 screens.
 *
 * OWN-WORLD: Security engraving. Intaglio green owns whole regions and bleeds to the
 * screen edge; rag paper carries the reading. Containers are engraved panels with a
 * hairline keyline and a corner notch, data-field grids, and a security thread — never
 * a card grid. Two colours only beyond the field: carmine for the word under pressure
 * (revoke, delete, decline) and latent gold for the thread, seals and guilloche.
 * Bodoni denominations, Archivo engraver's-gothic legends, Azeret Mono serials.
 *
 * STORY: The holder understands that each check is a step on one unbroken thread,
 * believes the consent and deletion guarantees because the interface states them in
 * microtext rather than marketing, and leaves possessing a credential they can read
 * aloud to a lender.
 *
 * FIRST VIEWPORT: The passport, full-bleed intaglio, occupying the top 45% of the
 * Passport tab: guilloche medallion top-right, the holder's name in Bodoni at 34,
 * the serial in mono along the base, the corridor panel IN <-> SG beside it, and the
 * latent score panel that resolves on press-and-hold. Primary action sits below the
 * note on rag, never on the field.
 *
 * FORM: Inherited world (pravaah-web/DESIGN.md) translated to native Operate mode.
 * No concept roll was run and none was appropriate: a sibling surface of an
 * established identity inherits it rather than re-deciding it.
 *
 * Every colour pair in this file is verified against WCAG 2.2 AA in BOTH themes.
 * The verified ratios are recorded in DESIGN.md. If you change a value here,
 * re-verify it there — "it looks fine" is not a check.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Palette
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Values shared by both themes.
 *
 * `field` is deliberately identical in light and dark. It is the one committed
 * colour of the brand, and a note does not change the colour of its own intaglio
 * because the room got dark. What changes is the GROUND behind it: in light the
 * ground is paper and the field is the darkest object; in dark the ground drops
 * BELOW the field so the field becomes the luminous one. That inversion of
 * relationship — rather than an inversion of values — is what keeps the passport
 * reading as an object you hold in both themes.
 */
const Shared = {
  field: '#0E3B2E',
  fieldDeep: '#082018',
  fieldMid: '#1A5A45',
  /** Text on the intaglio field. 10.77:1 — identical in both themes. */
  onField: '#EEEFE7',
  /** Secondary text on the field: tinted from the field hue, never gray. 6.67:1. */
  onFieldDim: '#A8C4B6',
  /** Gold that must be READ on the field. 6.03:1. */
  onFieldLatent: '#D9AE5A',
  /** Carmine that must be read on the field. 4.62:1. */
  onFieldCarmine: '#F0788D',
  /**
   * Engraved line work ON the intaglio field — a keyline, a data-field rule, the
   * notch. It must be LIGHTER than the field, because a line pressed into a dark
   * plate catches the light. Shared by both themes: the field does not change, so
   * neither does the line drawn on it. This is a separate token from `rule`
   * because in dark mode `panel` and `field` are the same colour, and a rule
   * tinted for the sheet is invisible there.
   */
  ruleOnField: '#38695A',
  /** The same line at emphasis — a data-field grid's outer edge on the field. */
  ruleOnFieldStrong: '#4E8271',
  /**
   * Decorative gold. 2.93:1 on rag — it may draw guilloche, rules and thread and
   * NOTHING a user has to read or act on. `latent` below is the readable gold.
   * The web file has a single --latent because on the web gold only ever appears
   * on the field; on rag it had to split.
   */
  latentLine: '#B08434',
} as const;

const light = {
  ...Shared,

  /** Security rag paper: cool, faint green cast. Deliberately never cream. */
  ground: '#EEEFE7',
  /** Recessed wells — inputs, code cells, the second tone of the sheet. */
  groundSunk: '#E2E5D9',
  /** A raised engraved panel, a half-tone above the sheet. */
  panel: '#F5F6F0',
  /** Hairline keyline on rag. */
  rule: '#CFD4C6',
  /** A stronger rule for a data-field grid's outer edge. */
  ruleStrong: '#B4BCA9',

  ink: '#101911',
  inkDim: '#4C5C50',
  /** Microtext floor. 4.62:1 on the harder of the two grounds. */
  inkFaint: '#55635A',

  carmine: '#A81F3C',
  carmineDeep: '#7C1129',
  /**
   * Readable gold on rag: 5.48:1 on the sheet, 4.97:1 in a well. Darker than the
   * web's gold because the web only ever puts gold on the intaglio field, where
   * a lighter value works; on paper it has to carry its own weight.
   */
  latent: '#7A5A1E',
  /**
   * The ink of a CLEARED status. On rag this is the field itself, which is the
   * strongest thing the palette can say: the check is now part of the note.
   */
  cleared: '#0E3B2E',

  /** A wash of the field, for selected rows and pressed states on rag. */
  fieldWash: 'rgba(14, 59, 46, 0.08)',
  carmineWash: 'rgba(168, 31, 60, 0.09)',
  latentWash: 'rgba(138, 103, 31, 0.11)',

  /** Press feedback: a darkening, because ink presses INTO paper. */
  press: 'rgba(16, 25, 17, 0.07)',
  /** Android ripple on rag. */
  ripple: 'rgba(14, 59, 46, 0.13)',
  /** Scrim behind a sheet or dialog. */
  scrim: 'rgba(8, 32, 24, 0.42)',

  shadow: '#0E3B2E',
  /** Camera/scan surfaces are black regardless of theme. */
  lens: '#05100C',
} as const;

const dark = {
  ...Shared,

  /**
   * The note under UV. The ground sits BELOW the field so the intaglio panel
   * reads as the lit object rather than the backdrop. Not pure black: a pure
   * black ground next to a green field turns the field muddy, and OLED smearing
   * on dark scroll is worse at #000.
   */
  ground: '#06120E',
  groundSunk: '#03090A',
  /** In dark the raised panel IS the field — the note glows. */
  panel: '#0E3B2E',
  rule: '#1E3A31',
  ruleStrong: '#2C5748',

  ink: '#EEEFE7',
  inkDim: '#A8C4B6',
  inkFaint: '#8CA79A',

  carmine: '#F0788D',
  carmineDeep: '#C2415A',
  latent: '#C79A46',
  /**
   * Under UV the field cannot also be the status ink — #0E3B2E on the #06120E
   * ground is 1.53:1, invisible. So a cleared status resolves to the field's own
   * hue lifted into legibility: still unmistakably intaglio, readable on the
   * ground AND on the panel.
   */
  cleared: '#54BE97',

  /**
   * Near-opaque DARK tints, not low-alpha bright ones.
   *
   * A low-alpha wash of a bright hue lightens whatever is beneath it, so the same
   * token produced a legible ground on the sheet (5.7:1) and an illegible one on a
   * panel (3.79:1) — the wash's behaviour depended on what it happened to be laid
   * over, which for a text ground is not acceptable. At 0.9 alpha over a dark tint
   * the result is effectively ground-independent: a tinted recess, which is closer
   * to what an inked panel on a note is anyway.
   */
  fieldWash: 'rgba(16, 58, 45, 0.92)',
  carmineWash: 'rgba(58, 14, 24, 0.92)',
  latentWash: 'rgba(52, 38, 12, 0.92)',

  /** Under UV, pressure LIGHTENS rather than darkens. */
  press: 'rgba(238, 239, 231, 0.09)',
  ripple: 'rgba(238, 239, 231, 0.13)',
  scrim: 'rgba(3, 9, 10, 0.62)',

  shadow: '#000000',
  lens: '#05100C',
} as const;

export const Palette = { light, dark } as const;

/**
 * The palette's SHAPE, with values widened to `string`.
 *
 * `as const` above is deliberate — it makes every hex a literal, which is what
 * lets `verify-contrast.mjs` and a reader see the exact value at the definition.
 * But a consumer must be able to hold "the active palette" without TypeScript
 * insisting `ground` is specifically `'#EEEFE7'` (which would make the dark
 * palette unassignable to the same type). This mapped type keeps the keys exact
 * and the values open, so the two themes are interchangeable at the type level
 * while a missing or misspelled token is still a compile error.
 */
export type Palette = { [K in keyof typeof light]: string };
export type PaletteColor = keyof Palette;

/* ────────────────────────────────────────────────────────────────────────────
   Status — the note's own two-colour system
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Seal SHAPE, not just colour. A status must survive greyscale, colour-blindness
 * and a screen reader, so every tone carries a distinct mark and a label:
 *
 *   filled  — cleared. The seal is struck and complete.
 *   open    — in flight or awaiting a person. The seal is drawn but not filled.
 *   struck  — refused or withdrawn. The seal is crossed.
 *   hollow  — not yet attempted, or lapsed. Outline only.
 */
export type StatusTone = 'field' | 'latent' | 'carmine' | 'neutral';
export type SealShape = 'filled' | 'open' | 'struck' | 'hollow';

export const STATUS_TONE: Record<StatusTone, SealShape> = {
  field: 'filled',
  latent: 'open',
  carmine: 'struck',
  neutral: 'hollow',
};

/**
 * Resolve a tone to its ink + wash for the active theme.
 *
 * `latent` resolves to the READABLE gold, never `latentLine` — a status is
 * information by definition.
 */
export function toneColor(
  tone: StatusTone,
  p: Palette,
): { ink: string; wash: string; rule: string } {
  switch (tone) {
    case 'field':
      return { ink: p.cleared, wash: p.fieldWash, rule: p.cleared };
    case 'latent':
      return { ink: p.latent, wash: p.latentWash, rule: p.latent };
    case 'carmine':
      return { ink: p.carmine, wash: p.carmineWash, rule: p.carmine };
    default:
      return { ink: p.inkDim, wash: 'transparent', rule: p.rule };
  }
}

/**
 * The same three tones as they must appear ON the intaglio field, where the
 * ground is the field itself and none of the above resolve. Used by the passport
 * and the tab bar.
 */
export function toneOnField(tone: StatusTone, p: Palette): string {
  switch (tone) {
    // Cleared reverses fully out of the field: the check IS the note now.
    case 'field':
      return p.onField;
    // Still in flight — the thread is lit, so gold.
    case 'latent':
      return p.onFieldLatent;
    case 'carmine':
      return p.onFieldCarmine;
    default:
      return p.onFieldDim;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Score bands — denominations
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A note series distinguishes value by colour, so the bands run as a perceptual
 * ramp TOWARD the field: earning your way into the note. There is deliberately no
 * red at the bottom — a FAIR score is a starting point, and the palette this
 * replaced styled it like a rejection.
 */
/** Widened for the same reason as `Palette` — see the note on that type. */
export type BandInk = { [K in keyof (typeof BAND_INK)['light']]: string };

export const BAND_INK = {
  light: {
    POOR: '#5F6B63',
    FAIR: '#6A5691',
    GOOD: '#245F84',
    VERY_GOOD: '#1A5A45',
    EXCELLENT: '#0E3B2E',
  },
  dark: {
    POOR: '#A9B6AC',
    FAIR: '#B49FDA',
    GOOD: '#74B4DC',
    VERY_GOOD: '#54BE97',
    EXCELLENT: '#8FE0B8',
  },
} as const;

/* ────────────────────────────────────────────────────────────────────────────
   Space, shape, depth
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A real 4pt scale. The incumbent `Spacing` was 2/4/8/16/24/32/64 — non-linear,
 * with a 2x jump to 64 and no value between 32 and 64 — and it doubled as the
 * RADIUS scale, which is why every corner in the app was 16 or 24.
 */
export const Space = {
  px: 1,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  h1: 40,
  h2: 48,
  h3: 64,
} as const;

/** Screen gutter. 20 on a phone: a note has a margin, not a hairline edge. */
export const Gutter = Space.xl;

/**
 * Engraved corners are TIGHT. A banknote's panels are cut, not rounded; the
 * incumbent's 16–24pt radii read as a consumer card UI, which is the opposite
 * of a security document.
 */
export const Radius = {
  none: 0,
  /** Wells, chips, small marks. */
  sm: 3,
  /** Panels, inputs, buttons. */
  md: 5,
  /** The note itself, and camera frames. */
  lg: 8,
  pill: 999,
} as const;

/** The size of the corner notch cut into an engraved panel. */
export const Notch = 10;

/** Hairlines are drawn at a real device pixel, not a rounded-up 1dp. */
export const Hairline = { thin: 0.5, base: 1, thick: 1.5 } as const;

/**
 * Depth carries an offset AND a blur. A zero-offset coloured halo is decoration,
 * and the note's own depth is a press impression — so shadows are tinted from
 * the field rather than neutral black.
 */
export const Elevation = {
  /** A panel lifted off the sheet. */
  panel: {
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  /** The note in the hand. */
  note: {
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 6,
  },
  /** The tab bar and any bar pinned over scrolling content. */
  bar: {
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 12,
  },
} as const;

/* ────────────────────────────────────────────────────────────────────────────
   Motion
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Springs, not durations, for anything a finger caused: a spring's velocity
 * carries the touch. Durations are reserved for things the SYSTEM caused
 * (a value arriving, a panel resolving).
 *
 * Every consumer must check `useReducedMotion()` and jump to the final value.
 */
export const Motion = {
  /** Press down / release. Fast, no visible overshoot. */
  press: { damping: 26, stiffness: 420, mass: 0.7 } as const,
  /** The tab indicator sliding. A little carry, no wobble. */
  slide: { damping: 22, stiffness: 260, mass: 0.9 } as const,
  /** A mark landing — the seal striking. Slight overshoot is the point. */
  strike: { damping: 13, stiffness: 240, mass: 0.8 } as const,

  /** Exponential ease-out. Everything decelerates; nothing eases in. */
  out: [0.16, 1, 0.3, 1] as const,

  duration: {
    /** A state crossfade. */
    fast: 140,
    /** A panel resolving, a rule drawing. */
    base: 260,
    /** The latent reveal. */
    reveal: 420,
    /** A value counting up. Long enough to read as arriving, not as a wait. */
    value: 900,
  },
} as const;

/** Minimum touch target, applied on both platforms. */
export const HitSize = 48;

/** Minimum gap between adjacent touch targets. */
export const HitGap = Space.sm;

/** A phone-width sheet never exceeds this; tablets get a centred column. */
export const MaxSheetWidth = 620;
