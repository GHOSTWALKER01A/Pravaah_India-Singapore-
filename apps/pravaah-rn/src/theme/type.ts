/**
 * The three faces from the note's world, and the roles they play.
 *
 * The incumbent scale had three sizes doing all the work — `title` at 48/52,
 * `subtitle` at 32/44, and everything else at 14 or 16 — which is why a screen
 * title overflowed a 20pt gutter and why there was no step between a heading and
 * body text. This is a real scale with named roles.
 *
 * Sizes are unitless RN values, which behave as `sp`: they scale with the OS font
 * setting. Nothing here sets `allowFontScaling: false`.
 */
import { Platform, type TextStyle } from 'react-native';

/* ── Families ──────────────────────────────────────────────────────────────── */

/**
 * Loaded by `useAppFonts`. The keys are the exact `@expo-google-fonts` export
 * names so the loader map and these styles can never drift apart.
 */
export const Family = {
  /** Bodoni Moda — the engraved denomination. */
  displayMedium: 'BodoniModa_500Medium',
  displaySemi: 'BodoniModa_600SemiBold',
  /** Archivo — legends and body. */
  sans: 'Archivo_400Regular',
  sansMedium: 'Archivo_500Medium',
  sansSemi: 'Archivo_600SemiBold',
  sansBold: 'Archivo_700Bold',
  /** Azeret Mono — serials and measured values. */
  mono: 'AzeretMono_500Medium',
  monoSemi: 'AzeretMono_600SemiBold',
} as const;

/* ── Roles ─────────────────────────────────────────────────────────────────── */

/**
 * `denomination` caps at 40, not the web's 6rem. A didone at display size on a
 * 360dp screen inside a 20pt gutter wraps mid-word; 40 is the largest size at
 * which a two-word Indian or Singaporean name still sets on one line, and the
 * passport is the only place it appears that large.
 *
 * Tracking on the display face is negative at every size — didone counters close
 * up when tracked out, which is the single fastest way to make Bodoni look wrong.
 */
export const Type = {
  /** The passport holder's name, and a screen's large title. */
  denomination: {
    fontFamily: Family.displayMedium,
    fontSize: 34,
    lineHeight: 38,
    letterSpacing: -0.6,
  },
  /** A screen title once it has collapsed into the bar, and section openers. */
  denominationSm: {
    fontFamily: Family.displayMedium,
    fontSize: 24,
    lineHeight: 29,
    letterSpacing: -0.3,
  },
  /**
   * The score. Its own role because it is the one number in the product that is
   * the product, and it needs tabular figures so it does not jitter counting up.
   */
  value: {
    fontFamily: Family.displaySemi,
    fontSize: 56,
    lineHeight: 60,
    letterSpacing: -1.4,
    fontVariant: ['tabular-nums'],
  },
  valueSm: {
    fontFamily: Family.displaySemi,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },

  /**
   * Engraver's gothic — the issuing-authority line.
   *
   * The web sets Archivo's variable `wdth` axis to 118 for this. React Native
   * cannot set font variation axes and Google publishes no static Archivo
   * Expanded, so the native legend is SemiBold + uppercase + heavy tracking. The
   * recognisable trait (a wide, tracked, all-caps issuing line) survives; the
   * width axis does not. Do not fake it with a horizontal scale transform — that
   * distorts the stems and looks like a bug.
   *
   * `letterSpacing` is absolute in RN, not em-relative: 2 at 11pt ≈ 0.18em.
   */
  legend: {
    fontFamily: Family.sansSemi,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  legendSm: {
    fontFamily: Family.sansSemi,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },

  /** A heading inside a screen — the step above body, below the denomination. */
  heading: {
    fontFamily: Family.sansSemi,
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.1,
  },
  /** A row title, a panel's own title. */
  title: {
    fontFamily: Family.sansSemi,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0,
  },

  /** Body copy. 16/24 is the reading size; do not go below it for prose. */
  body: { fontFamily: Family.sans, fontSize: 16, lineHeight: 24 },
  bodyMedium: { fontFamily: Family.sansMedium, fontSize: 16, lineHeight: 24 },
  /** Secondary prose and helper text. */
  bodySm: { fontFamily: Family.sans, fontSize: 14, lineHeight: 21 },
  bodySmMedium: { fontFamily: Family.sansMedium, fontSize: 14, lineHeight: 21 },

  /** A control's own label. Never smaller than 14 — a button is not fine print. */
  label: {
    fontFamily: Family.sansSemi,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.1,
  },

  /**
   * Microtext — the audit trail under the surface. The note's fine print, and
   * REAL text, never a texture. 11/16 is the floor and it is still held to
   * 4.5:1, which is why `inkFaint` is as dark as it is.
   */
  micro: { fontFamily: Family.sans, fontSize: 11, lineHeight: 16 },
  microMedium: { fontFamily: Family.sansMedium, fontSize: 11, lineHeight: 16 },

  /**
   * Serials, identifiers, dates, amounts, counts. Measurement — never a costume
   * for "technical". Always tabular so a changing value does not shift width.
   */
  serial: {
    fontFamily: Family.monoSemi,
    fontSize: 18,
    lineHeight: 26,
    letterSpacing: 1.6,
    fontVariant: ['tabular-nums'],
  },
  field: {
    fontFamily: Family.mono,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
  fieldSm: {
    fontFamily: Family.mono,
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
} as const satisfies Record<string, TextStyle>;

export type TypeRole = keyof typeof Type;

/**
 * Roles that must not grow without bound when the OS font size is cranked up,
 * because they live inside a fixed-geometry object (the note, a data-field grid)
 * that would reflow into nonsense. Everything NOT listed here scales freely —
 * this list is deliberately short, and prose is never on it.
 */
export const MaxScale: Partial<Record<TypeRole, number>> = {
  denomination: 1.35,
  value: 1.3,
  valueSm: 1.3,
  serial: 1.2,
  legend: 1.4,
  legendSm: 1.4,
};

/**
 * Android renders both Bodoni and Azeret Mono visibly lighter than iOS at the
 * same nominal weight, a known difference in the two text engines' stem
 * rendering. Nudging the Android glyphs up one step keeps the two platforms
 * looking like the same design instead of two different ones.
 */
export const platformFamily = (family: string): string => {
  if (Platform.OS !== 'android') return family;
  if (family === Family.displayMedium) return Family.displaySemi;
  if (family === Family.mono) return Family.monoSemi;
  return family;
};
