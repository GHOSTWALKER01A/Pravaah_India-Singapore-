/**
 * The one-time code field.
 *
 * The incumbent's mechanics were genuinely good and are kept verbatim: one real
 * hidden `TextInput` behind display cells, so OS SMS autofill (`oneTimeCode` on
 * iOS, `sms-otp` on Android) and paste-the-whole-code both work, with the cells
 * only providing the look. That is the right architecture and it is preserved.
 *
 * What changes is everything the user perceives:
 *   - cells are wells cut into the sheet, with the active one keylined in gold
 *   - a filled digit lands with a spring, so entry has a physical response
 *   - a wrong code SHAKES — two cycles, 3px — instead of silently turning red.
 *     This is the only shake in the app, which is what makes it mean something.
 *   - the caret blinks on a real timer rather than sitting as a static bar
 */
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import {
  Hairline,
  Motion,
  Radius,
  Space,
  Type,
  platformFamily,
  useMotionOk,
  usePalette,
} from '@/theme';

interface OtpInputProps {
  value: string;
  onChangeText: (value: string) => void;
  length?: number;
  autoFocus?: boolean;
  error?: boolean;
  onComplete?: (code: string) => void;
  editable?: boolean;
}

export function OtpInput({
  value,
  onChangeText,
  length = 6,
  autoFocus = true,
  error = false,
  onComplete,
  editable = true,
}: OtpInputProps) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  const shake = useSharedValue(0);
  const caret = useSharedValue(1);

  // Fire onComplete exactly once when the code fills up.
  const completedRef = useRef(false);
  useEffect(() => {
    if (value.length === length && !completedRef.current) {
      completedRef.current = true;
      onComplete?.(value);
    }
    if (value.length < length) completedRef.current = false;
  }, [value, length, onComplete]);

  // The refusal. Fires on the transition into error, not on every error render.
  const wasError = useRef(false);
  useEffect(() => {
    if (error && !wasError.current && motionOk) {
      shake.value = withSequence(
        withTiming(-3, { duration: 55 }),
        withTiming(3, { duration: 55 }),
        withTiming(-2, { duration: 55 }),
        withTiming(0, { duration: 55 }),
      );
    }
    wasError.current = error;
  }, [error, motionOk, shake]);

  // The caret. A real blink, so the active cell reads as awaiting input.
  useEffect(() => {
    if (!focused || !editable || !motionOk) {
      caret.value = 1;
      return;
    }
    caret.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 480, easing: Easing.linear }),
        withTiming(1, { duration: 480, easing: Easing.linear }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(caret);
  }, [focused, editable, motionOk, caret]);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shake.value }],
  }));

  const activeIndex = Math.min(value.length, length - 1);

  return (
    <Animated.View style={rowStyle}>
      <Pressable
        onPress={() => inputRef.current?.focus()}
        style={styles.row}
        // The row is a single field, not six. Announcing six boxes to a screen
        // reader is how a segmented OTP usually becomes unusable.
        accessibilityRole="none"
        accessible={false}
      >
        {Array.from({ length }, (_, i) => (
          <Cell
            key={i}
            char={value[i] ?? ''}
            active={focused && editable && i === activeIndex}
            error={error}
            caret={caret}
          />
        ))}

        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={(raw) => onChangeText(raw.replace(/\D/g, '').slice(0, length))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={editable}
          autoFocus={autoFocus}
          keyboardType="number-pad"
          maxLength={length}
          caretHidden
          // OS SMS autofill. Kept exactly as the incumbent had it — it worked.
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
          importantForAutofill="yes"
          accessibilityLabel={`${length}-digit verification code`}
          style={styles.hiddenInput}
        />
      </Pressable>
    </Animated.View>
  );
}

function Cell({
  char,
  active,
  error,
  caret,
}: {
  char: string;
  active: boolean;
  error: boolean;
  /**
   * The blink driver itself, not a built style. One timer in the parent drives
   * every cell (so they blink in phase), but the style is derived HERE — an
   * animated style is a view style, and threading one through props means the
   * parent has to guess which element it will land on.
   */
  caret: SharedValue<number>;
}) {
  const p = usePalette();
  const motionOk = useMotionOk();
  const filled = useSharedValue(char ? 1 : 0);
  const caretStyle = useAnimatedStyle(() => ({ opacity: caret.value }));

  useEffect(() => {
    const to = char ? 1 : 0;
    filled.value = motionOk ? withSpring(to, Motion.strike) : to;
  }, [char, motionOk, filled]);

  // The digit arrives at slight overshoot — a key struck, not a value assigned.
  const digitStyle = useAnimatedStyle(() => ({
    opacity: filled.value,
    transform: [{ scale: 0.72 + filled.value * 0.28 }],
  }));

  const border = error ? p.carmine : active ? p.latent : char ? p.ruleStrong : p.rule;

  return (
    <View
      style={[
        styles.cell,
        {
          backgroundColor: p.groundSunk,
          borderColor: border,
          borderWidth: active || error ? Hairline.thick : Hairline.base,
        },
      ]}
    >
      {char ? (
        // An Animated.View wrapping a plain Text, not an Animated.Text: the
        // animated style here is a transform, and Reanimated types a transform
        // style as a view style — passing it to Animated.Text is a type error and
        // would also opt the text out of font scaling on Android.
        <Animated.View style={digitStyle}>
          <Text
            style={[
              styles.digit,
              { fontFamily: platformFamily(Type.serial.fontFamily), color: p.ink },
            ]}
            // The cell is a fixed 58dp box with a fixed line height, so an
            // unbounded multiplier clipped the digit at large OS text sizes. 1.15
            // is the most the box can hold. This is the one place in the app that
            // caps a scale for geometry rather than for identity — six cells have
            // to fit one screen width, so they cannot grow.
            maxFontSizeMultiplier={1.15}
          >
            {char}
          </Text>
        </Animated.View>
      ) : active ? (
        <Animated.View style={[styles.caret, { backgroundColor: p.latent }, caretStyle]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: Space.sm },
  cell: {
    flex: 1,
    height: 58,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digit: { fontSize: 26, lineHeight: 32, fontVariant: ['tabular-nums'] },
  caret: { width: Hairline.thick + 0.5, height: 24 },
  hiddenInput: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0,
    color: 'transparent',
  },
});
