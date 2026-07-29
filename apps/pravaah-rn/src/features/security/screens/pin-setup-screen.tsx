import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Micro,
  Notice,
  OtpInput,
  Panel,
  Rule,
  Screen,
  SectionHead,
  Text,
  haptic,
} from '@/components/ui';
import { Space } from '@/theme';

import { PIN_LENGTH } from '../security-meta';
import { usePin } from '../use-pin';

/**
 * Set a PIN for the first time.
 *
 * ## Where this sits in the enrolment order, and why the order is not arbitrary
 *
 * The sequence is **SMS OTP → biometric → PIN**, and each step exists because the one before it
 * could not do its job:
 *
 *  1. **The SMS OTP** proves the SIM is physically in this handset. That is the ONLY step that
 *     ties the account to a device, and every later factor is measured against that tie. It has
 *     to be first, because a PIN set on an unrecognised device is a factor with nothing to pair
 *     against.
 *  2. **The biometric** is recorded next, because it is what will later authorise CHANGING the
 *     PIN. Setting the PIN first and the biometric afterwards would leave a window where the PIN
 *     can only be changed by SMS — the weaker route — on an account that was about to have a
 *     stronger one.
 *  3. **The PIN** last. It is the factor used on every payment, and the one the user will
 *     remember.
 *
 * ## Why confirmation is a second entry and not a "show PIN" toggle
 *
 * A reveal button solves the typo problem by defeating the masking, on the one screen where
 * somebody is most likely to be watching — a person setting up a payment PIN is often doing it
 * with a helper, a shop assistant, or a family member beside them. Typing it twice costs six
 * digits and reveals nothing.
 *
 * ## Why weak-PIN rejection comes from the SERVER
 *
 * The rule list is a detector specification. Shipping it to the client would tell an attacker
 * exactly which patterns survive, and a client-side check is bypassed by anyone talking to the
 * API directly anyway. So this screen sends the PIN and renders whatever the server says — which
 * is also why the error copy here is generic and the specific one ("that PIN is too easy to
 * guess") arrives from the API.
 */
export function PinSetupScreen() {
  const router = useRouter();
  const { status, loading, error, busy, enrol, refresh } = usePin();

  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  /** A mismatch is a LOCAL error and must not be conflated with the server's. */
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);

  /**
   * Clear both fields whenever the server rejects.
   *
   * Leaving them populated invites the user to edit six digits they can no longer see — the
   * masking that protects the PIN also makes a half-corrected entry impossible to check. A clear
   * plus the field's own shake reads as one event: that was refused, start again.
   */
  useEffect(() => {
    if (error) {
      setPin('');
      setConfirmation('');
      setMismatch(false);
    }
  }, [error]);

  const submit = async () => {
    if (busy) return;

    if (pin !== confirmation) {
      setMismatch(true);
      setConfirmation('');
      haptic.refused();
      return;
    }

    setMismatch(false);
    const ok = await enrol(pin);
    if (ok) {
      haptic.commit();
      setDone(true);
      /**
       * Cleared on success as well as on failure.
       *
       * The screen stays mounted to show the confirmation, and a PIN sitting in component state
       * behind it would be one memory dump or one screenshot of a backgrounded app away from
       * being read. There is no reason to keep it after the server has the hash.
       */
      setPin('');
      setConfirmation('');
      await refresh();
    }
  };

  /**
   * An already-enrolled account is sent to the change flow rather than shown this screen.
   *
   * Not merely tidier: `enrol` REFUSES when a PIN exists, so leaving the form here would let a
   * user type twelve digits to reach an error the screen already had the information to prevent.
   * The change flow is the correct route, and it demands a biometric — which is the point.
   */
  const alreadySet = status?.enrolled === true && !done;

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Set your PIN' }} />

      <SectionHead
        title="Your payment PIN"
        detail="Six digits, needed to send money. This is a Pravaah PIN — not your UPI PIN."
      />

      {/*
        Said plainly, and said FIRST, because the confusion is a phishing vector rather than a
        UX nicety. Users are trained to type a UPI PIN whenever a payment screen asks for one,
        and that habit is the most valuable thing an attacker can exploit. Naming the difference
        at the moment the user forms their mental model is the only place it lands.
      */}
      <View style={styles.block}>
        <Notice tone="caution" title="This is not your UPI PIN">
          Your UPI PIN belongs to your bank and is entered in your bank&apos;s
          own screen. Pravaah never sees it. This PIN authorises payments from
          your Pravaah wallet, and only Pravaah will ever ask for it.
        </Notice>
      </View>

      {alreadySet ? (
        <Panel style={styles.block}>
          <Text role="body">You already have a PIN set.</Text>
          <Rule />
          <Button
            label="Change my PIN"
            onPress={() => router.back()}
            variant="secondary"
          />
        </Panel>
      ) : done ? (
        <Panel style={styles.block}>
          <Text role="heading">Your PIN is set</Text>
          <Text role="bodySm" tone="dim" style={styles.gap}>
            You will be asked for it when you send money. Payments under ₹500
            will not ask, so small everyday payments stay quick.
          </Text>
          <Rule />
          <Button label="Done" onPress={() => router.back()} />
        </Panel>
      ) : (
        <Panel style={styles.block}>
          <Text role="bodySm" style={styles.label}>
            Choose a PIN
          </Text>
          <OtpInput
            value={pin}
            onChangeText={setPin}
            length={PIN_LENGTH}
            secure
            autoFocus
            editable={!busy && !loading}
            error={Boolean(error)}
            accessibilityLabel="Choose a 6-digit PIN"
          />

          <Text role="bodySm" style={styles.labelSpaced}>
            Type it again
          </Text>
          <OtpInput
            value={confirmation}
            onChangeText={(next) => {
              setConfirmation(next);
              if (mismatch) setMismatch(false);
            }}
            length={PIN_LENGTH}
            secure
            autoFocus={false}
            editable={!busy && !loading && pin.length === PIN_LENGTH}
            error={mismatch}
            accessibilityLabel="Confirm your 6-digit PIN"
          />

          {mismatch ? (
            <Text role="bodySmMedium" tone="carmine" style={styles.gap}>
              Those did not match. Try the second one again.
            </Text>
          ) : null}

          {error ? (
            <Text role="bodySmMedium" tone="carmine" style={styles.gap}>
              {error}
            </Text>
          ) : null}

          {/*
            Guidance, not a validator.

            It tells the user what will be refused so the refusal is not a surprise, without
            enumerating the rules — the full list is a detector specification and belongs on the
            server. "Avoid" rather than "you cannot" because the server has the final say and the
            client should not claim to know its answer.
          */}
          <Micro tone="faint" style={styles.gap}>
            Avoid a birth year, repeated digits, or a run like 123456.
          </Micro>

          <Rule />

          <Button
            label="Set PIN"
            onPress={() => void submit()}
            disabled={
              pin.length < PIN_LENGTH ||
              confirmation.length < PIN_LENGTH ||
              busy ||
              loading
            }
            loading={busy}
          />
        </Panel>
      )}

      <View style={styles.tail} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: Space.xl },
  label: { marginBottom: Space.md },
  labelSpaced: { marginTop: Space.xl, marginBottom: Space.md },
  gap: { marginTop: Space.md },
  tail: { height: Space.xxl },
});
