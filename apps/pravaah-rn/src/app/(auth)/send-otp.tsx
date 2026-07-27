import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { ApiError } from '@/api';
import {
  Button,
  GuillocheBand,
  Icon,
  Legend,
  Micro,
  Notice,
  Screen,
  Text,
  TextField,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { APP_NAME } from '@/constants/ui.constants';
import { useAuth } from '@/context/auth-context';
import { Space, usePalette } from '@/theme';

const DEFAULT_CODE = '+91';

/**
 * The first screen anyone sees.
 *
 * The incumbent opened with a tracked "PRAVAAH" eyebrow, a 48pt "Verify you", the
 * tagline, and two bare fields — a title that says nothing about what the app is,
 * next to an unexplained phone box. For an audience whose first question is
 * literally "is this real, or is it another app that wants my bank password?",
 * that is the wrong opening.
 *
 * This one states what the credential is before it asks for anything, and answers
 * the password question in the same viewport rather than after signup.
 */
export default function SendOtpScreen() {
  const { sendOtp } = useAuth();
  const p = usePalette();
  const [code, setCode] = useState(DEFAULT_CODE);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<TextInput>(null);

  const ready = phone.trim().length >= 6 && code.trim().length >= 2;

  async function submit() {
    if (!ready || loading) return;
    setError(null);
    setLoading(true);
    try {
      await sendOtp({ phone: phone.trim(), countryCode: code.trim() });
      router.push(ROUTES.AUTH.VERIFY_OTP);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'We could not send the code. Check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <View style={styles.sheet}>
        <View style={styles.masthead}>
          <Legend tone="latent">{APP_NAME}</Legend>
          <Text role="denomination">Your financial reputation, carried across the border.</Text>
          <View style={styles.band} pointerEvents="none">
            <GuillocheBand width={520} height={18} lines={6} opacity={0.5} />
          </View>
        </View>

        <View style={styles.form}>
          <View style={styles.fields}>
            <View style={styles.code}>
              <TextField
                label="Code"
                value={code}
                onChangeText={setCode}
                measured
                keyboardType="phone-pad"
                maxLength={4}
                returnKeyType="next"
                onSubmitEditing={() => phoneRef.current?.focus()}
              />
            </View>
            <View style={styles.number}>
              <TextField
                ref={phoneRef}
                label="Phone number"
                value={phone}
                onChangeText={(t) => setPhone(t.replace(/\D/g, ''))}
                measured
                keyboardType="phone-pad"
                // No placeholder here on purpose. A plausible number set in the
                // mono face read as an already-entered value on device — the field
                // looked filled. Other fields keep a placeholder because theirs is
                // an obvious FORMAT MASK (ABCDE1234F, MM/YY), which cannot be
                // mistaken for real data. The example lives in the hint instead.
                hint={phone.length === 0 ? 'Ten digits, no spaces or country code.' : undefined}
                maxLength={15}
                textContentType="telephoneNumber"
                autoComplete="tel"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
              />
            </View>
          </View>

          {error ? <Notice tone="error">{error}</Notice> : null}

          <Button
            label="Send me a code"
            onPress={() => void submit()}
            loading={loading}
            disabled={!ready}
          />

          <Micro center>
            A one-time code by SMS. Standard message rates may apply.
          </Micro>
        </View>

        {/* The question this audience arrives with, answered before they are
            asked for anything. */}
        <View style={[styles.assurance, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={14} color={p.latent} weight={1.4} />
          <View style={styles.assuranceText}>
            <Text role="bodySm" tone="dim">
              Pravaah never asks for a bank password and never sees one. Financial
              data arrives only through India&apos;s regulated Account Aggregator
              rail, only for a purpose you approve, and you can delete it at any
              moment.
            </Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxxl, paddingTop: Space.h1 },
  masthead: { gap: Space.md, paddingBottom: Space.lg },
  band: { position: 'absolute', left: -Space.xl, right: 0, bottom: -Space.xs },
  form: { gap: Space.md },
  fields: { flexDirection: 'row', gap: Space.md, alignItems: 'flex-start' },
  code: { width: 96 },
  number: { flex: 1 },
  /**
   * Deliberately NOT `marginTop: 'auto'`.
   *
   * Pinning this to the bottom dumped every pixel of slack into one gap — seen on
   * a Pixel 7a, roughly 40% of the screen was empty between the SMS note and this
   * line, in both themes. The assurance belongs immediately under the form it
   * reassures about; whitespace below the last element is ordinary and reads as
   * finished, whereas a void in the middle reads as broken.
   */
  assurance: {
    flexDirection: 'row',
    gap: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  assuranceText: { flex: 1, maxWidth: 460 },
});
