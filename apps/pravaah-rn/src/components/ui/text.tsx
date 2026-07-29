/**
 * Every piece of text in the app goes through here.
 *
 * Replaces `ThemedText`, whose eight variants leaned on three sizes and mapped
 * colour through a five-key palette. Two things are different and both matter:
 * `role` names a job in the note's typography rather than a size, and `tone`
 * resolves against the SURFACE the text sits on — because the same "secondary
 * text" is `inkDim` on rag and `onFieldDim` on the intaglio field, and getting
 * that wrong is how you end up with gray text on a coloured ground.
 */
import {
  Text as RNText,
  useWindowDimensions,
  type TextProps as RNTextProps,
} from 'react-native';

import { MaxScale, Type, platformFamily, usePalette } from '@/theme';
import type { TypeRole } from '@/theme';

/**
 * Where this text is sitting. `field` means the intaglio ground — the passport,
 * the tab bar, a drenched region — and switches the whole tone ramp over to the
 * reversed-out set.
 */
export type Surface = 'sheet' | 'field';

export type Tone =
  | 'default'
  | 'dim'
  | 'faint'
  | 'latent'
  | 'carmine'
  | 'cleared'
  | 'inherit';

/**
 * `role` is omitted from the RN props it extends. React Native's `role` is the
 * ARIA role (`'heading' | 'link' | …`), which would collide with the typographic
 * role this component is built around. The app uses `accessibilityRole` for
 * semantics — it is the prop that actually works on both platforms — so nothing
 * is lost by taking the name.
 */
export interface TextProps extends Omit<RNTextProps, 'role'> {
  role?: TypeRole;
  tone?: Tone;
  surface?: Surface;
  /** Centre the line. Named because `style={{textAlign}}` at 40 call sites is noise. */
  center?: boolean;
}

function resolveTone(
  tone: Tone,
  surface: Surface,
  p: ReturnType<typeof usePalette>,
): string | undefined {
  if (tone === 'inherit') return undefined;
  if (surface === 'field') {
    switch (tone) {
      case 'dim':
        return p.onFieldDim;
      // There is no third tier on the field: a 4.6:1 faint tone reversed out of a
      // saturated ground is where legibility actually breaks, so it collapses to
      // the secondary tone rather than inventing an unreadable one.
      case 'faint':
        return p.onFieldDim;
      case 'latent':
        return p.onFieldLatent;
      case 'carmine':
        return p.onFieldCarmine;
      case 'cleared':
        return p.onField;
      default:
        return p.onField;
    }
  }
  switch (tone) {
    case 'dim':
      return p.inkDim;
    case 'faint':
      return p.inkFaint;
    case 'latent':
      return p.latent;
    case 'carmine':
      return p.carmine;
    case 'cleared':
      return p.cleared;
    default:
      return p.ink;
  }
}

export function Text({
  role = 'body',
  tone = 'default',
  surface = 'sheet',
  center,
  style,
  ...rest
}: TextProps) {
  const p = usePalette();
  const base = Type[role];

  /**
   * Scale `lineHeight` with the OS font size.
   *
   * React Native scales `fontSize` when the user raises their system font size, but it
   * leaves an explicitly-set `lineHeight` exactly as written. Every role in `Type` sets
   * one, so at a large font scale the glyphs outgrow their line boxes and MULTI-LINE text
   * collapses into itself — lines overlapping each other and bleeding into whatever sits
   * below.
   *
   * `denomination` is the worst case and the one that exposed this: 34pt text in a 38pt
   * line box has only 4pt of slack, so it breaks at a font scale of about 1.12 — well
   * inside what people actually use. It went unnoticed because single-line display text
   * usually has room to spill into; the first component to wrap a denomination to three
   * lines rendered them on top of one another.
   *
   * `fontScale` comes from `useWindowDimensions` rather than `PixelRatio.getFontScale()`
   * because it is reactive — a user changing their font size mid-session re-renders.
   * `MaxScale` is applied here too, so the line box tracks the CAPPED growth that
   * `maxFontSizeMultiplier` actually permits rather than the uncapped OS value.
   */
  const { fontScale } = useWindowDimensions();
  const cap = MaxScale[role];
  const effectiveScale = cap ? Math.min(fontScale, cap) : fontScale;
  const scaledLineHeight =
    typeof base.lineHeight === 'number' && effectiveScale !== 1
      ? { lineHeight: base.lineHeight * effectiveScale }
      : null;

  return (
    <RNText
      // Only fixed-geometry roles are capped, and prose never is. See MaxScale.
      maxFontSizeMultiplier={cap}
      style={[
        base,
        { fontFamily: platformFamily(base.fontFamily) },
        // Before `style`, so a caller can still pin its own lineHeight deliberately.
        scaledLineHeight,
        { color: resolveTone(tone, surface, p) },
        center && { textAlign: 'center' },
        style,
      ]}
      {...rest}
    />
  );
}

/**
 * The issuing-authority line: wide, tracked, all-caps.
 *
 * A component rather than `<Text role="legend">` for one reason — it uppercases
 * its own content. `textTransform` alone leaves the accessible name lowercase on
 * some Android TalkBack versions, so the string is transformed for real and the
 * style is belt-and-braces.
 *
 * Use ONE legend per region. The note has a single issuing line; an eyebrow over
 * every block is grammar nobody chose.
 */
export function Legend({
  children,
  small,
  ...rest
}: Omit<TextProps, 'role' | 'children'> & {
  children: string;
  small?: boolean;
}) {
  return (
    <Text role={small ? 'legendSm' : 'legend'} {...rest}>
      {children.toUpperCase()}
    </Text>
  );
}

/**
 * The note's fine print. Real text at the microtext size — the audit trail under
 * the surface, never a decorative texture and never lorem.
 */
export function Micro({ role = 'micro', tone = 'faint', ...rest }: TextProps) {
  return <Text role={role} tone={tone} {...rest} />;
}

/**
 * A measured value: a serial, a date, an amount, a count. Tabular figures, so a
 * value that changes does not shift the layout around it.
 */
export function FieldValue({ role = 'field', ...rest }: TextProps) {
  return <Text role={role} {...rest} />;
}
