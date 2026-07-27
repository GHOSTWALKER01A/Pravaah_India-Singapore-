/**
 * A text field, as a recess in the plate.
 *
 * Changes from the incumbent that are behaviour, not looks:
 *   - The focus state was invisible. There was no `onFocus` at all, so the border
 *     stayed `Brand.border` (a fixed light-grey hex, unchanged in dark mode) whether
 *     the field was focused or not.
 *   - `hint` rendered in the default ink at the same size as the label, so a format
 *     error and a helper note were indistinguishable. Errors are now carmine, get
 *     `accessibilityLiveRegion`, and name the format rather than restating it.
 *   - The label was not associated with the input, so a screen reader read an
 *     unlabelled text box.
 *   - No `returnKeyType` or submit chaining, so the keyboard's action key did
 *     nothing on a three-field form (the bank screen).
 */
import { forwardRef, useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { Hairline, HitSize, Radius, Space, Type, platformFamily, usePalette } from '@/theme';

import { Icon } from './icon';
import { Legend, Text } from './text';

export interface TextFieldProps
  extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  /** A neutral helper note. Always visible; not a validation message. */
  hint?: string;
  /** A validation problem. Names the problem AND the fix. Replaces `hint`. */
  error?: string | null;
  /**
   * Set values in the measured face: a PAN, an IFSC, an account number. Prose
   * fields (a name, an address) stay in the body face.
   */
  measured?: boolean;
  /** Shown once the value validates — quiet confirmation, not a celebration. */
  valid?: boolean;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    value,
    onChangeText,
    hint,
    error,
    measured = false,
    valid = false,
    // Destructured so a caller passing either cannot silently replace the
    // handlers that drive the focus ring — `{...rest}` is spread BEFORE them
    // below, and both are chained.
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);

  // Focus is the strongest signal, then error, then a filled resting state.
  const border = error ? p.carmine : focused ? p.latent : value ? p.ruleStrong : p.rule;

  const face = measured ? Type.field : Type.body;

  return (
    <View style={styles.wrap}>
      {/* Hidden from assistive tech on BOTH platforms: `importantForAccessibility`
          is Android-only and `accessibilityElementsHidden` is iOS-only, so a field
          labelled on one platform stays double-announced on the other. The input
          below carries the accessible name. */}
      <View
        style={styles.labelRow}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Legend small tone="faint">
          {label}
        </Legend>
        {valid && !error ? <Icon name="check" size={13} color={p.cleared} weight={2} /> : null}
      </View>

      <View
        style={[
          styles.well,
          {
            backgroundColor: p.groundSunk,
            borderColor: border,
            // The focus ring is a weight change, not a coloured glow.
            borderWidth: focused || error ? Hairline.thick : Hairline.base,
          },
        ]}
      >
        <TextInput
          ref={ref}
          {...rest}
          value={value}
          onChangeText={onChangeText}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          placeholderTextColor={p.inkFaint}
          // The input carries the name; the visible legend above is hidden from
          // the tree (see below). The reverse — a visible label node plus a
          // labelled input — announced every field's name twice.
          accessibilityLabel={label}
          // Only the hint. The error already has its own `role="alert"` node
          // below; repeating it here made it a third announcement of one problem.
          accessibilityHint={hint}
          style={[
            styles.input,
            face,
            { fontFamily: platformFamily(face.fontFamily), color: p.ink },
          ]}
        />
      </View>

      {/* The message slot keeps its height whether or not it holds a message, so
          validating a field does not shove the submit button down the screen. */}
      <View style={styles.messageSlot}>
        {error ? (
          <Text
            role="micro"
            tone="carmine"
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
          >
            {error}
          </Text>
        ) : hint ? (
          <Text role="micro" tone="faint">
            {hint}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: Space.sm },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  well: { borderRadius: Radius.md, justifyContent: 'center' },
  input: {
    minHeight: HitSize,
    paddingHorizontal: Space.lg,
    // Vertical padding rather than a fixed height, so the field grows with the
    // OS font size instead of clipping its own text.
    paddingVertical: Space.md,
  },
  messageSlot: { minHeight: 16 },
});
