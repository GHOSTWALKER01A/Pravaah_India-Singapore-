/**
 * The single entry point for the design system.
 *
 * Screens import from `@/theme` and nowhere else. The old arrangement had colour
 * split across `constants/theme.ts` (a light/dark pair of five values) and
 * `constants/ui.constants.ts` (an unrelated `Brand` object), so half the app
 * styled itself against a theme-aware token and half against a fixed hex — which
 * is why the incumbent app had border colours that did not change in dark mode.
 */
export {
  BAND_INK,
  Elevation,
  Gutter,
  Hairline,
  HitGap,
  HitSize,
  MaxSheetWidth,
  Motion,
  Notch,
  Palette,
  Radius,
  STATUS_TONE,
  Space,
  toneColor,
  toneOnField,
  type PaletteColor,
  type SealShape,
  type StatusTone,
} from './tokens';

export { Family, MaxScale, Type, platformFamily, type TypeRole } from './type';

export { useAppFonts } from './use-fonts';

export {
  ThemeProvider,
  useBand,
  useIsDark,
  useMotionOk,
  usePalette,
  useScheme,
} from './theme-provider';
