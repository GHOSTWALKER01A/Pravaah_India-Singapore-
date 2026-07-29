import { StyleSheet, View } from 'react-native';

import { FieldValue, Legend, Micro, Rule, Text } from '@/components/ui';
import { Space, usePalette } from '@/theme';

import { amountInWords, formatWithSymbol } from '../money';

/**
 * The amount line — figures above, words below.
 *
 * This is the reason the whole payments surface is modelled on a cheque book. It is not
 * ornament: **the amount in words is the single most effective error check in the history of
 * paper finance**, and it costs one line of screen to render.
 *
 * `₹2,50,000` and `₹25,000` differ by one glyph. A person confirming a payment scans the figure,
 * sees the digits they expected, and taps. But "Two lakh fifty thousand rupees" and "Twenty-five
 * thousand rupees" cannot be confused by anybody, in any light, in a hurry, at night, on a
 * cracked screen. A mistyped zero is the most common catastrophic payment error there is, and
 * banks solved it three hundred years ago by making the payer write the amount twice in two
 * different notations.
 *
 * Two details that make it actually work rather than merely appear:
 *
 * - **Indian numbering.** "Two lakh fifty thousand", never "two hundred fifty thousand". The
 *   words have to be in the system the reader counts in, or the cross-check they are performing
 *   against the 2,2,3-grouped figure fails.
 * - **The words are not truncated.** Ever. A clipped amount line is worse than no amount line,
 *   because it looks like a check has been performed when it has not. It wraps instead.
 */
interface AmountLineProps {
  /** Integer minor units. */
  minor: string;
  currency: string;
  /** Pre-formatted figure from the server, when there is one. Preferred over re-deriving. */
  formatted?: string;
  /** On the intaglio field rather than on rag. */
  onField?: boolean;
  /** The denomination scale. `lead` is the confirmation screen's hero. */
  size?: 'lead' | 'row';
  label?: string;
}

export function AmountLine({
  minor,
  currency,
  formatted,
  onField = false,
  size = 'lead',
  label,
}: AmountLineProps) {
  const p = usePalette();
  const surface = onField ? 'field' : 'sheet';

  const figures = formatted ?? formatWithSymbol(minor, currency);
  const words = amountInWords(minor, currency);

  if (size === 'row') {
    return (
      <View style={styles.row}>
        <FieldValue surface={surface}>{figures}</FieldValue>
        <Micro surface={surface} style={styles.wordsRow}>
          {words}
        </Micro>
      </View>
    );
  }

  return (
    <View
      style={styles.lead}
      // The figure and the words are ONE fact for assistive tech. A screen reader that read
      // them as two would say the amount twice, which is confusing rather than reassuring —
      // the redundancy is for the eye, not the ear.
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${label ? `${label}. ` : ''}${words}`}
    >
      {label ? (
        <Legend small surface={surface}>
          {label}
        </Legend>
      ) : null}

      <Text
        role="denomination"
        surface={surface}
        // The one place a figure may not reflow: it is the object under confirmation, and a
        // mid-word wrap on a didone at 40sp is illegible. Everything else on this screen scales.
        maxFontSizeMultiplier={1.6}
      >
        {figures}
      </Text>

      {/* The score line between figures and words, as printed on a cheque. */}
      <Rule onField={onField} />

      <Text
        role="bodySm"
        tone="dim"
        surface={surface}
        style={[styles.words, { color: onField ? p.onFieldDim : p.inkDim }]}
      >
        {words}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lead: { gap: Space.sm },
  row: { alignItems: 'flex-end', gap: 2 },
  // No `numberOfLines`. See the class comment: a clipped amount line looks like a performed
  // check that was not performed.
  words: { fontStyle: 'italic' },
  wordsRow: { textAlign: 'right' },
});
