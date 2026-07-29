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

import { biometricLabel, readBiometricCapability } from '../biometric';
import { PIN_LENGTH, STEP_UP_OTP_LENGTH } from '../security-meta';
import { usePin } from '../use-pin';

/**
 * Change or reset the PIN.
 *
 * ## Two routes, deliberately unequal
 *
 * **Change** is authorised by a BIOMETRIC, with the device passcode refused. Instant, no
 * after-effects.
 *
 * **Reset** is authorised by an SMS code, and costs a 24-hour cooling-off during which large
 * transfers stay under review.
 *
 * The asymmetry is the design, and it is worth stating why rather than treating the reset as a
 * lesser version of the same thing:
 *
 * A PIN system needs "I forgot it", and that path is almost always an SMS code — which quietly
 * hands the stolen-phone attacker a way to simply RESET the PIN and pay. The weakness the PIN was
 * built to close, reopened one screen back. Banks answer it with a possession factor: the debit
 * card's last six digits and expiry, which a phone thief does not have. Pravaah has no card, so
 * the reset instead buys time — for a day afterwards the risk engine's device signals still apply,
 * so "reset and drain" becomes "reset, then wait while somebody reviews it".
 *
 * That cost is disclosed BEFORE the user commits, not after. A user who discovers the friction
 * only when their transfer is held experiences a malfunction; one who was told experiences a
 * trade-off they accepted.
 *
 * ## Why the biometric route is offered first and not merely by default
 *
 * If both routes were equally prominent, users would pick whichever needed less thought — and the
 * cheap one for them is the expensive one for their security. Leading with the biometric and
 * placing the reset behind "I have forgotten my PIN" matches the actual situations: one is a
 * choice, the other is a recovery.
 */
export function PinChangeScreen() {
  const router = useRouter();
  const { status, loading, error, busy, change, requestReset, reset, refresh } =
    usePin();

  const [mode, setMode] = useState<'change' | 'reset'>('change');
  const [newPin, setNewPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** The reset's outstanding SMS challenge. `null` until one has been asked for. */
  const [resetNonce, setResetNonce] = useState<string | null>(null);
  const [smsCode, setSmsCode] = useState('');

  const [label, setLabel] = useState('Device unlock');
  const [canUseBiometric, setCanUseBiometric] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const capability = await readBiometricCapability();
      if (!alive) return;
      setLabel(biometricLabel(capability));
      setCanUseBiometric(capability.canUseBiometric);
      /**
       * Start on the RESET route when the device cannot do a biometric at all.
       *
       * Landing on a change form whose only button raises a prompt that will immediately fail is
       * a dead end dressed as a choice. Better to open on the route that can actually complete,
       * with the reason stated.
       */
      if (!capability.canUseBiometric) setMode('reset');
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * A locked PIN forces the reset route.
   *
   * `change` would be refused server-side anyway — a locked PIN is not changeable, it is
   * resettable — so offering the biometric route here would spend the user's biometric on a
   * request that cannot succeed.
   */
  useEffect(() => {
    if (status?.locked) setMode('reset');
  }, [status?.locked]);

  useEffect(() => {
    if (error || localError) {
      setNewPin('');
      setConfirmation('');
      setMismatch(false);
    }
  }, [error, localError]);

  const bothEntered =
    newPin.length === PIN_LENGTH && confirmation.length === PIN_LENGTH;

  const checkMatch = (): boolean => {
    if (newPin !== confirmation) {
      setMismatch(true);
      setConfirmation('');
      haptic.refused();
      return false;
    }
    setMismatch(false);
    return true;
  };

  const submitChange = async () => {
    if (busy || !checkMatch()) return;
    setLocalError(null);

    const outcome = await change(newPin);
    if (outcome.ok) {
      haptic.commit();
      setDone(true);
      setNewPin('');
      setConfirmation('');
      await refresh();
      return;
    }

    setLocalError(outcome.message);
    /**
     * Move the user to the reset route when the biometric route is genuinely unavailable to
     * them — but NOT when they simply cancelled.
     *
     * `canResetInstead` carries that distinction from the hook. Switching on a cancel would
     * answer a question the user did not ask, and push them toward a slower path with a
     * cooling-off attached because they tapped the wrong thing once.
     */
    if (outcome.canResetInstead) setMode('reset');
  };

  const startReset = async () => {
    setLocalError(null);
    const issued = await requestReset();
    if (issued) setResetNonce(issued.nonce);
  };

  const submitReset = async () => {
    if (busy || !resetNonce || !checkMatch()) return;
    setLocalError(null);

    const ok = await reset({
      newPin,
      nonce: resetNonce,
      answer: smsCode,
    });

    if (ok) {
      haptic.commit();
      setDone(true);
      setNewPin('');
      setConfirmation('');
      setSmsCode('');
      setResetNonce(null);
      await refresh();
    }
  };

  const shown = localError ?? error;

  if (done) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'PIN updated' }} />
        <Panel style={styles.block}>
          <Text role="heading">Your PIN has been updated</Text>
          {mode === 'reset' ? (
            <Text role="bodySm" tone="dim" style={styles.gap}>
              For the next 24 hours, larger payments may take a little longer
              while we check them. This is normal after a reset.
            </Text>
          ) : (
            <Text role="bodySm" tone="dim" style={styles.gap}>
              Use your new PIN the next time you send money.
            </Text>
          )}
          <Rule />
          <Button label="Done" onPress={() => router.back()} />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Stack.Screen
        options={{ title: mode === 'change' ? 'Change PIN' : 'Reset PIN' }}
      />

      <SectionHead
        title={mode === 'change' ? 'Change your PIN' : 'Reset your PIN'}
        detail={
          mode === 'change'
            ? `We will ask for ${label.toLowerCase()} first, so only you can change it.`
            : 'We will send a code to your registered number.'
        }
      />

      {mode === 'reset' ? (
        <View style={styles.block}>
          {/*
            The cooling-off, disclosed before the user commits rather than discovered afterwards.

            This is the single most important string on the screen. Without it, a user who resets
            their PIN and then finds their transfer held has experienced a bug; with it, they have
            accepted a trade. It is also the honest answer to why the reset is not simply the
            easier way to change a PIN.
          */}
          <Notice tone="caution" title="A reset slows large payments for a day">
            Because a code sent to your phone is weaker proof than your
            fingerprint, larger payments will be reviewed for 24 hours after a
            reset. If you can, use {label.toLowerCase()} to change your PIN
            instead.
          </Notice>
        </View>
      ) : null}

      {status?.locked ? (
        <View style={styles.block}>
          <Notice tone="error" title="Your PIN is locked">
            Too many incorrect attempts. Resetting it is the way back in.
          </Notice>
        </View>
      ) : null}

      {canUseBiometric === false && mode === 'reset' ? (
        <View style={styles.block}>
          <Notice tone="caution" title="No fingerprint or face set up">
            Changing a PIN needs a fingerprint or face check, which this phone
            does not have set up. Add one in your phone settings to use the
            faster route next time.
          </Notice>
        </View>
      ) : null}

      <Panel style={styles.block}>
        {mode === 'reset' && !resetNonce ? (
          <>
            <Text role="body">
              We will text a code to the number on your account.
            </Text>
            <Rule />
            <Button
              label="Send me a code"
              onPress={() => void startReset()}
              loading={busy}
              disabled={busy || loading}
            />
          </>
        ) : (
          <>
            {mode === 'reset' && resetNonce ? (
              <>
                <Text role="bodySm" style={styles.label}>
                  Enter the code we sent you
                </Text>
                <OtpInput
                  value={smsCode}
                  onChangeText={setSmsCode}
                  length={STEP_UP_OTP_LENGTH}
                  autoFocus
                  editable={!busy}
                  error={Boolean(shown)}
                />
              </>
            ) : null}

            <Text
              role="bodySm"
              style={
                mode === 'reset' && resetNonce
                  ? styles.labelSpaced
                  : styles.label
              }
            >
              Choose a new PIN
            </Text>
            <OtpInput
              value={newPin}
              onChangeText={setNewPin}
              length={PIN_LENGTH}
              secure
              autoFocus={mode === 'change'}
              editable={!busy && !loading}
              error={Boolean(shown)}
              accessibilityLabel="Choose a new 6-digit PIN"
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
              editable={!busy && newPin.length === PIN_LENGTH}
              error={mismatch}
              accessibilityLabel="Confirm your new 6-digit PIN"
            />

            {mismatch ? (
              <Text role="bodySmMedium" tone="carmine" style={styles.gap}>
                Those did not match. Try the second one again.
              </Text>
            ) : null}

            {shown ? (
              <Text role="bodySmMedium" tone="carmine" style={styles.gap}>
                {shown}
              </Text>
            ) : null}

            <Micro tone="faint" style={styles.gap}>
              Avoid a birth year, repeated digits, or a run like 123456.
            </Micro>

            <Rule />

            <Button
              label={
                mode === 'change'
                  ? `Confirm with ${label.toLowerCase()}`
                  : 'Reset my PIN'
              }
              onPress={() =>
                void (mode === 'change' ? submitChange() : submitReset())
              }
              disabled={
                !bothEntered ||
                busy ||
                loading ||
                (mode === 'reset' && smsCode.length < STEP_UP_OTP_LENGTH)
              }
              loading={busy}
            />
          </>
        )}
      </Panel>

      {/*
        The route switch, placed last and worded as a situation rather than an option.

        "I have forgotten my PIN" describes a state the user is in; "use SMS instead" describes a
        preference, and inviting a preference between a strong factor and a weak one is inviting
        the wrong answer.
      */}
      {mode === 'change' ? (
        <View style={styles.block}>
          <Button
            label="I have forgotten my PIN"
            onPress={() => {
              setMode('reset');
              setLocalError(null);
            }}
            variant="quiet"
            disabled={busy}
          />
        </View>
      ) : canUseBiometric && !status?.locked ? (
        <View style={styles.block}>
          <Button
            label={`Change it with ${label.toLowerCase()} instead`}
            onPress={() => {
              setMode('change');
              setResetNonce(null);
              setSmsCode('');
              setLocalError(null);
            }}
            variant="quiet"
            disabled={busy}
          />
        </View>
      ) : null}

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
