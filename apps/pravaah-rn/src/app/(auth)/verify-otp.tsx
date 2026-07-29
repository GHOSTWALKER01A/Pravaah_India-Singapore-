import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '@/api';
import {
  Button,
  Header,
  Micro,
  Notice,
  OtpInput,
  Press,
  Screen,
  Text,
  haptic,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';
import { HitSize, Radius, Space } from '@/theme';

const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;

export default function VerifyOtpScreen() {
  const { pending, verifyOtp, resendOtp } = useAuth();
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);

  // Guards against the button and auto-submit both firing a verify at once.
  const busy = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  /**
   * Handed to `<OtpInput onComplete>`, which names it in an effect dependency array — so a
   * changing identity would ordinarily be a re-submit hazard. It is not one here: that effect
   * is latched by a `completedRef`, and this function is additionally guarded by `busy`, so a
   * re-run cannot produce a second verification of the same code.
   */
  const verify = async (codeValue: string) => {
    if (busy.current || codeValue.length !== OTP_LENGTH) return;
    busy.current = true;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await verifyOtp(codeValue);
      haptic.cleared();
      router.replace(ROUTES.AUTH.ONBOARDING);
    } catch (err) {
      // The shake, the haptic and the message are one event. A wrong code is
      // the most common failure in the whole app and it has to be unmistakable
      // without being punishing.
      haptic.refused();
      setError(
        err instanceof ApiError
          ? err.message
          : 'That code was not right, or it has expired. Check the last message and try again.',
      );
      setOtp('');
    } finally {
      setLoading(false);
      busy.current = false;
    }
  };

  async function resend() {
    if (cooldown > 0 || resending) return;
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      await resendOtp();
      setOtp('');
      setNotice('A new code is on its way.');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resend the code.');
    } finally {
      setResending(false);
    }
  }

  // No number in flight — bounce back to the start. After the hooks, so hook
  // order stays stable across renders.
  if (!pending) return <Redirect href={ROUTES.AUTH.SEND_OTP} />;

  const destination = `${pending.countryCode} ${pending.phone}`;

  return (
    <Screen>
      <View style={styles.sheet}>
        <Header
          title="Enter your code"
          lede={`We sent ${OTP_LENGTH} digits to ${destination}.`}
        />

        <View style={styles.form}>
          <OtpInput
            value={otp}
            onChangeText={(v) => {
              setOtp(v);
              if (error) setError(null);
            }}
            length={OTP_LENGTH}
            error={Boolean(error)}
            editable={!loading}
            onComplete={verify}
          />

          {/* A fixed slot: the message must not shove the button when it appears. */}
          <View style={styles.messages}>
            {error ? (
              <Notice tone="error">{error}</Notice>
            ) : notice ? (
              <Notice tone="cleared">{notice}</Notice>
            ) : (
              <Micro>On most phones the code fills itself in from your SMS.</Micro>
            )}
          </View>

          <Button
            label="Verify"
            onPress={() => void verify(otp)}
            loading={loading}
            disabled={otp.length !== OTP_LENGTH}
          />

          <View style={styles.resend}>
            <Micro tone="dim">Didn&apos;t get it?</Micro>
            {cooldown > 0 ? (
              <Micro tone="dim">{`Resend in 0:${String(cooldown).padStart(2, '0')}`}</Micro>
            ) : (
              <Press
                onPress={() => void resend()}
                depth="subtle"
                radius={Radius.sm}
                accessibilityRole="button"
                accessibilityLabel="Resend the code"
              >
                <View style={styles.resendTarget}>
                  <Text role="bodySmMedium" tone="latent">
                    {resending ? 'Resending…' : 'Resend code'}
                  </Text>
                </View>
              </Press>
            )}
          </View>
        </View>

        <View style={styles.foot}>
          <Button
            label="Wrong number? Change it"
            variant="quiet"
            onPress={() => router.replace(ROUTES.AUTH.SEND_OTP)}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxxl, paddingTop: Space.xxl },
  form: { gap: Space.lg },
  messages: { minHeight: 44, justifyContent: 'center' },
  resend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
    flexWrap: 'wrap',
  },
  resendTarget: {
    minHeight: HitSize,
    justifyContent: 'center',
    paddingHorizontal: Space.md,
  },
  // Sits under the resend row, not pinned to the bottom — see the note on
  // send-otp's `assurance` style for why nothing here claims the slack.
  foot: { alignItems: 'center' },
});
