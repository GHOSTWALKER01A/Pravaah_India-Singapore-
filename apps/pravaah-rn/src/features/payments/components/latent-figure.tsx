import { StyleSheet, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

import { Micro, Press, Text } from '@/components/ui';
import { Type, usePalette } from '@/theme';

import type { MoneyView } from '@/api/payments/schemas';

/**
 * A denomination that is concealed until the holder presses and holds it — the note's latent image,
 * applied to the balance.
 *
 * Concealed, the figure's place is held by engraved lozenges at the denomination's own size, so the
 * plate does not reflow when the value arrives. That is the whole reason for the placeholder: a
 * concealed state that collapsed would make the leaf jump every time the balance resolved, and a
 * jumping plate reads as a glitch rather than as a security device.
 *
 * The lozenge count is fixed rather than derived from the digits. Deriving it would leak the
 * magnitude of the balance — eight lozenges versus four tells an onlooker whether this person has
 * thousands or lakhs, which is most of what they wanted to know.
 *
 * Accessibility is the part most implementations of this get wrong. The figure must remain reachable
 * without a long press, because a long press is awkward under a screen reader and impossible under
 * some switch-access setups. So the whole plate carries an `accessibilityAction` that reveals it, and
 * the label states which state it is in. A screen-reader user is not asked to perform a gesture whose
 * purpose is to defeat a shoulder-surfer who, by definition, is looking at the screen.
 */
interface LatentFigureProps {
  balance: MoneyView | null;
  revealed: boolean;
  onReveal: () => void;
  onConceal: () => void;
  /** What the figure is. Read out before the value. */
  label: string;
}

/** Fixed, and deliberately not the digit count. See the component comment. */
const LOZENGE_COUNT = 6;

/**
 * The concealed figure, as generated geometry rather than a typed character.
 *
 * The obvious implementation is a string of `◈` (U+25C8) at the denomination's size, and it is a trap:
 * this app ships eight specific font files, and Bodoni Moda's coverage of the Geometric Shapes block is
 * not something to assume. A missing glyph renders as a tofu box, so the balance would be concealed by
 * six empty rectangles that look like a rendering failure rather than a security device — on the first
 * screen of the Pay tab, in whichever theme the user opens.
 *
 * Drawing it also satisfies the rule the world already sets: ornament here is "real generated geometry,
 * never a raster texture". A lozenge is two triangles; there is no reason to ask a font for one.
 */
function Lozenges({ colour, height }: { colour: string; height: number }) {
  const unit = height * 0.42;
  const gap = unit * 0.55;
  const width = LOZENGE_COUNT * unit + (LOZENGE_COUNT - 1) * gap;

  return (
    <Svg
      width={width}
      height={height}
      // Decorative: the plate's own label states that the balance is hidden.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: LOZENGE_COUNT }, (_, i) => {
        const cx = i * (unit + gap) + unit / 2;
        const cy = height / 2;
        const r = unit / 2;
        return (
          <G key={i}>
            {/* Outer lozenge, stroked — the engraved mark. */}
            <Path
              d={`M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`}
              stroke={colour}
              strokeWidth={1.4}
              fill="none"
            />
            {/* Inner lozenge, filled. The two together read as a security mark rather than as a
                diamond outline, at the size a denomination occupies. */}
            <Path
              d={`M${cx} ${cy - r * 0.42} L${cx + r * 0.42} ${cy} L${cx} ${cy + r * 0.42} L${cx - r * 0.42} ${cy} Z`}
              fill={colour}
            />
          </G>
        );
      })}
    </Svg>
  );
}

export function LatentFigure({
  balance,
  revealed,
  onReveal,
  onConceal,
  label,
}: LatentFigureProps) {
  const p = usePalette();

  const showing = revealed && balance !== null;

  return (
    <Press
      // `none`: this is a full-bleed plate region, and scaling the intaglio field under the thumb
      // reads as the whole leaf wobbling rather than as a control responding.
      depth="none"
      ink={false}
      ripple={false}
      onLongPress={onReveal}
      onPressOut={onConceal}
      // 120ms rather than the 500ms default. The gesture is a deliberate hold, but at half a second
      // it feels broken — the user presses, nothing happens, and they conclude the figure is missing.
      delayLongPress={120}
      accessibilityRole="button"
      accessibilityLabel={
        showing
          ? `${label}: ${balance.formatted}`
          : `${label}, hidden. Reveal to hear the amount.`
      }
      accessibilityHint={
        showing ? undefined : 'Press and hold, or use the reveal action'
      }
      accessibilityActions={[{ name: 'activate', label: 'Reveal the balance' }]}
      onAccessibilityAction={onReveal}
    >
      <View style={styles.block}>
        {showing ? (
          <Text
            role="denomination"
            surface="field"
            // A fixed-width object on a plate: it may grow with the OS setting, but not so far that
            // it wraps mid-figure. Everything else on the leaf scales without a cap.
            maxFontSizeMultiplier={1.5}
            numberOfLines={1}
          >
            {balance.formatted}
          </Text>
        ) : (
          // Sized to the denomination's own line height so the plate does not reflow when the real
          // figure replaces it. Not font-scaled: the concealed state carries no text to read.
          <View style={styles.concealed}>
            <Lozenges
              colour={p.onFieldDim}
              height={Type.denomination.lineHeight}
            />
          </View>
        )}

        <Micro surface="field">
          {balance === null
            ? 'no balance yet'
            : showing
              ? 'release to hide'
              : 'hold to reveal'}
        </Micro>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  block: { gap: 2 },
  // Matches the revealed figure's own box so swapping between the two never shifts the rule below.
  concealed: { justifyContent: 'center' },
});
