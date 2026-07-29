import { StyleSheet, TextInput, View } from 'react-native';

import { Legend, Micro, Rule, Text } from '@/components/ui';
import { Space, Type, usePalette } from '@/theme';

import {
  CURRENCY_META,
  amountInWords,
  amountToMinor,
  currencySymbol,
  formatEntry,
  isAmountEmpty,
  type AmountEntry,
} from '../money';

/**
 * The amount line, WRITABLE — the drawing counterpart to {@link AmountLine}.
 *
 * `AmountLine` renders an amount that has already been decided. This renders the one being decided,
 * and it exists because six screens (send, scan, topup, withdraw, request, new AutoPay) had each
 * hand-rolled the identical thirty-line block: symbol, formatted `TextInput`, score rule, words.
 *
 * That duplication was not merely repetitive, it was *dangerous*. The words below the figure are the
 * cheque's anti-error device, and six copies of the code that renders them is six chances for one
 * screen to quietly drop it, clip it, or feed it the wrong currency. The one screen that lost its
 * words would look completely normal and would silently stop performing the only check that catches
 * a mistyped zero. Once, here, is the whole point.
 *
 * Three details carried over from every copy, each load-bearing:
 *
 * - **The input shows the FORMATTED figure and accepts only digits.** The user types `2 5 0 0 0 0`
 *   and reads `2,50,000.00`. Letting the field hold raw text would mean parsing a partly-typed
 *   number on every keystroke.
 * - **`maxFontSizeMultiplier` is capped at 1.5.** The denomination face at 40sp is the object under
 *   confirmation; unbounded scaling wraps it mid-figure and it stops being legible. Everything else
 *   on these screens scales freely.
 * - **The words never truncate.** No `numberOfLines`. A clipped amount line looks like a check that
 *   was performed when it was not, which is worse than showing nothing.
 */
interface AmountFieldProps {
  entry: AmountEntry;
  onChange: (entry: AmountEntry) => void;
  currency: string;
  /** What this amount is FOR. "How much", "Amount to request", "Amount — you enter it". */
  label: string;
  /** Shown under the words. The place to say why the amount is the user's to choose. */
  hint?: string;
  autoFocus?: boolean;
  /**
   * The prompt shown in place of the words before anything is typed.
   *
   * Present rather than blank on purpose: an empty line where the words will appear reads as a
   * layout gap, whereas naming it tells the user a second reading of their figure is coming.
   */
  emptyHint?: string;
}


/**
 * Turn whatever the keyboard produced back into an `AmountEntry`.
 *
 * A `TextInput` can be pasted into and can receive a whole string at once, so this cannot assume it
 * is handling one keypress. It re-derives the entry from the text: digits before the first separator
 * are the whole part, digits after it are the fraction, and anything past the currency's exponent is
 * dropped rather than rounded.
 *
 * A trailing separator is PRESERVED as `fraction: ''`, which is what keeps the point on screen while
 * the user is between pressing `.` and typing the paise. Stripping it would make the key appear to do
 * nothing.
 */
function parseTyped(text: string, currency: string): AmountEntry {
  // Typed as `number`, not the literal `2` the lookup infers — otherwise the zero-exponent guard
  // below reads to TypeScript as an impossible comparison, and the guard is real for any currency
  // without sub-units that gets added later.
  const exponent: number =
    CURRENCY_META[currency as keyof typeof CURRENCY_META]?.exponent ?? 2;
  // Both separators are accepted: a comma is what several Android keyboards emit for the decimal key.
  const cleaned = text.replace(/[^0-9.,]/g, '').replace(/,/g, '.');
  const firstDot = cleaned.indexOf('.');

  if (firstDot < 0 || exponent === 0) {
    return { whole: cleaned.replace(/\./g, '').slice(0, 9), fraction: null };
  }

  return {
    whole: cleaned.slice(0, firstDot).slice(0, 9),
    fraction: cleaned
      .slice(firstDot + 1)
      .replace(/\./g, '')
      .slice(0, exponent),
  };
}

export function AmountField({
  entry,
  onChange,
  currency,
  label,
  hint,
  autoFocus = false,
  emptyHint = 'The amount will be written out here as you type',
}: AmountFieldProps) {
  const p = usePalette();
  const empty = isAmountEmpty(entry, currency);
  const minor = amountToMinor(entry, currency);

  return (
    <View style={styles.block}>
      <Legend small>{label}</Legend>

      <View style={styles.figureRow}>
        <Text role="denomination" tone="dim">
          {currencySymbol(currency)}
        </Text>
        {/*
          `formatEntry`, not `formatMinor`.

          `formatMinor` renders a settled amount and always shows the sub-unit, so under a cursor it
          padded what the user was still typing — `5` became `₹0.05` and `500` became `₹005.00`. This
          draws exactly the digits pressed.

          `decimal-pad` rather than `number-pad`: the keyboard now has to offer the separator, because
          entering paise is the only way to reach a sub-rupee amount.
        */}
        <TextInput
          value={formatEntry(entry, currency)}
          onChangeText={(text) => onChange(parseTyped(text, currency))}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={p.inkFaint}
          autoFocus={autoFocus}
          maxFontSizeMultiplier={1.5}
          style={[
            styles.figureInput,
            { color: p.ink, fontFamily: Type.denomination.fontFamily },
          ]}
          accessibilityLabel={`${label} in ${currency}`}
        />
      </View>

      {/* The score line between figures and words, as printed on a cheque. */}
      <Rule />

      {/*
        Faint while it is still a prompt, dim once it is a real reading of the figure. Five of the
        six screens this replaced used `inkDim` for both, which made the placeholder look like an
        amount that had been written out; the send screen had it right and that is the version kept.
      */}
      <Text
        role="bodySm"
        style={[styles.words, { color: empty ? p.inkFaint : p.inkDim }]}
      >
        {empty ? emptyHint : amountInWords(minor, currency)}
      </Text>

      {hint ? <Micro>{hint}</Micro> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: Space.sm },
  figureRow: { flexDirection: 'row', alignItems: 'baseline', gap: Space.xs },
  figureInput: {
    // `flexGrow`, never `flex: 1` — in React Native `flex: 1` also sets `flexBasis: 0`, which
    // collapses the field to nothing beside the symbol.
    flexGrow: 1,
    flexShrink: 1,
    fontSize: Type.denomination.fontSize,
    lineHeight: Type.denomination.lineHeight,
    letterSpacing: Type.denomination.letterSpacing,
    padding: 0,
  },
  // No `numberOfLines`. See the component comment.
  words: { fontStyle: 'italic' },
});
