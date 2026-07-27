/**
 * The data-field grid — the note's way of stating a set of facts.
 *
 * This replaces the shape the incumbent app reached for whenever it had facts to
 * show: a card per fact, or a `flexDirection: 'row', justifyContent: 'space-between'`
 * with two `<ThemedText type="small">`. The second one had a real bug the code
 * itself documented — a right-aligned `flex: 1` column inside an unbounded parent
 * collapsed the rows to zero width, which is why `consent/new.tsx` carries a
 * comment explaining why one block had to be full-width instead.
 *
 * Here the label is a legend and the value is measured (mono, tabular), rules
 * divide the rows, and long values wrap under their label rather than fighting it
 * for the same line.
 */
import { Children, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Space } from '@/theme';

import { Panel, Rule } from './panel';
import { FieldValue, Legend, Text } from './text';
import type { Surface, Tone } from './text';

export interface FieldRowProps {
  label: string;
  /** The value as a string. Use `children` instead for a value with structure. */
  value?: string;
  children?: ReactNode;
  /** The tone of the value — carmine for a retention period, latent for pending. */
  tone?: Tone;
  surface?: Surface;
  /**
   * Long values (a purpose sentence, a date range) read as prose, not as a
   * measurement, so they set in the body face and wrap under the label.
   */
  prose?: boolean;
}

export function FieldRow({
  label,
  value,
  children,
  tone = 'default',
  surface = 'sheet',
  prose = false,
}: FieldRowProps) {
  const stacked = prose || (value != null && value.length > 22);

  return (
    <View
      style={[
        styles.row,
        stacked && styles.stacked,
        // `baseline` is right for two runs of text, but wrong the moment the value
        // is a component with its own geometry — a status seal has no text
        // baseline to align to, so it sat low against its label.
        !stacked && children != null && styles.rowCentred,
      ]}
    >
      <Legend
        small
        tone={surface === 'field' ? 'dim' : 'faint'}
        surface={surface}
        // Shrinks and truncates rather than shoving the value out of the plate.
        numberOfLines={stacked ? undefined : 1}
        style={stacked ? undefined : styles.label}
      >
        {label}
      </Legend>

      {children != null ? (
        /**
         * Wrapped, and allowed to shrink.
         *
         * Bare children had no width constraint while the label had
         * `flexShrink: 0`, so a wide pair — "VERIFICATION" beside a "✓ VERIFIED"
         * mark — overflowed the cell's right padding and ran to the plate's edge.
         * Flexbox overflows rather than clipping, so it looked like the padding
         * had simply been forgotten.
         */
        <View style={styles.slot}>{children}</View>
      ) : prose ? (
        <Text role="bodySm" tone={tone} surface={surface}>
          {value}
        </Text>
      ) : (
        <FieldValue
          tone={tone}
          surface={surface}
          style={stacked ? undefined : styles.value}
        >
          {value}
        </FieldValue>
      )}
    </View>
  );
}

/**
 * A set of field rows, ruled and plated.
 *
 * `pad="none"` on the Panel plus per-row padding, so the rules run the full width
 * of the plate the way they do on a note rather than floating inset inside it.
 */
export function FieldGrid({
  children,
  rule,
  tone,
}: {
  children: ReactNode;
  rule?: string;
  tone?: 'panel' | 'sunk';
}) {
  // `Children.toArray`, not `Array.isArray`. A caller mixing a `.map()` with a
  // conditional child produces a NESTED array, which the naive check collapsed
  // into a single "row" — one rule would then cover the whole group. toArray
  // flattens and drops nullish children in one pass.
  const rows = Children.toArray(children);
  return (
    <Panel pad="none" rule={rule} tone={tone}>
      {rows.map((row, i) => (
        // Index keys are correct here: these rows are a fixed, ordered set
        // declared in source, never a reordered or filtered collection.
        <View key={i}>
          {i > 0 ? <Rule /> : null}
          <View style={styles.cell}>{row}</View>
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.lg,
  },
  stacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: Space.xs,
  },
  rowCentred: { alignItems: 'center' },
  // The label holds its width against a text value (which takes the remaining
  // space and right-aligns), but yields to a component value, which cannot
  // reflow. `flexShrink: 1` + `numberOfLines` means the LABEL truncates in a
  // tight row instead of the value escaping the plate.
  label: { flexShrink: 1 },
  value: { flex: 1, textAlign: 'right' },
  // Right-aligned, shrinkable, and never wider than the space left over.
  slot: { flexShrink: 0, alignItems: 'flex-end', maxWidth: '70%' },
  cell: { paddingHorizontal: Space.lg, paddingVertical: Space.md },
});
