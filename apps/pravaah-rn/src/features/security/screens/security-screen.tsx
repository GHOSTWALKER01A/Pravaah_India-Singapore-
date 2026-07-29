import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  SectionHead,
  Screen,
  Text,
} from '@/components/ui';
import { Space } from '@/theme';

import type { StepUpChallenge } from '@/api/security/schemas';
import { ROUTES } from '@/constants/routes.constants';

import { DeviceRow } from '../components/device-row';
import { StepUpPrompt } from '../components/step-up-prompt';
import { resolveDeviceId } from '../device-identity';
import { PIN_EXEMPT_BELOW_RUPEES, isThisDevice } from '../security-meta';
import { usePin } from '../use-pin';
import { useDevices } from '../use-devices';

/**
 * "Your devices" — the self-service account-takeover defence.
 *
 * ## Why this screen is worth building before any detection
 *
 * The account holder notices a device they do not recognise before any model does. That is
 * not a hypothetical: it is the single fastest ATO signal available, and it is free. A user
 * who can revoke in one tap has stopped a takeover in the window where stopping it is cheap;
 * a user who has to reach support has lost that window.
 *
 * So the list is a plain read, the revoke needs no confirmation dialog, and nothing here is
 * behind a challenge. The controls that COST something — binding, recovering — are the ones
 * that add capability. Removing capability is always free.
 */
export function SecurityScreen() {
  const router = useRouter();
  const {
    devices,
    loading,
    error,
    busyId,
    refresh,
    revoke,
    requestRecovery,
    recover,
  } = useDevices();

  /**
   * The PIN state, read on this screen because it is where a user comes to manage security.
   *
   * A separate hook from the devices one, not folded in: the two answer different questions and
   * fail independently. A devices fetch that times out must not blank the PIN panel, and a user
   * whose PIN just locked needs to see that even if the device list is unavailable.
   */
  const pin = usePin();

  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /**
   * Recovery state, held here rather than in the row.
   *
   * The challenge belongs to the SCREEN because only one device can be mid-recovery at a
   * time — a second `requestRecovery` expires the first challenge server-side, so modelling
   * it per-row would let the UI show two live prompts when only one code works.
   */
  const [recovering, setRecovering] = useState<{
    deviceRef: string;
    challenge: StepUpChallenge;
  } | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setLocalDeviceId(await resolveDeviceId()))();
  }, []);

  /**
   * A one-minute tick, for the "last used" and cooling-off lines.
   *
   * A minute, not a second: nothing on this screen changes faster than that, and a
   * per-second re-render of a list for relative timestamps is battery spent on nothing.
   */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const startRecovery = async (deviceRef: string) => {
    setRecoverError(null);
    const result = await requestRecovery(deviceRef);
    if (result.challenge) {
      setRecovering({ deviceRef, challenge: result.challenge });
      return;
    }
    setRecoverError(result.error ?? 'Could not start verification.');
  };

  const submitRecovery = async (answer: string) => {
    if (!recovering) return;
    setRecoverError(null);
    const result = await recover(
      recovering.deviceRef,
      recovering.challenge.nonce,
      answer,
    );
    if (result.ok) {
      setRecovering(null);
      return;
    }
    setRecoverError(result.error ?? 'That code was not correct.');
  };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Security' }} />

      <SectionHead
        title="Your devices"
        detail="Devices that can access your account. Remove any you do not recognise."
      />

      {error ? (
        <Notice tone="error" action="Try again" onAction={() => void refresh()}>
          {error}
        </Notice>
      ) : null}

      {/*
        The recovery prompt, rendered ABOVE the list while it is live.

        Above rather than inline with its row, because a keyboard-covered prompt in the
        middle of a scrolling list is a prompt the user has to hunt for — and this one appears
        in response to their own tap, so it should be where they are already looking.
      */}
      {recovering ? (
        <View style={styles.block}>
          <StepUpPrompt
            challenge={recovering.challenge}
            onSubmit={(answer) => void submitRecovery(answer)}
            onResend={() => void startRecovery(recovering.deviceRef)}
            busy={busyId === recovering.deviceRef}
            error={recoverError}
            reason="Confirm the code we sent you to verify this device again."
          />
          <Button
            label="Not now"
            onPress={() => {
              setRecovering(null);
              setRecoverError(null);
            }}
            variant="quiet"
          />
        </View>
      ) : null}

      {loading ? (
        <ListSkeleton rows={2} label="Loading your devices" />
      ) : devices.length === 0 ? (
        <Panel>
          <Text role="bodyMedium">No devices registered yet</Text>
          <Text role="bodySm" tone="dim" style={styles.empty}>
            This phone registers itself the first time you sign in. If nothing appears
            here, larger payments will ask you to confirm them with a code.
          </Text>
        </Panel>
      ) : (
        <Panel>
          {devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              isCurrent={isThisDevice(device, localDeviceId)}
              busy={busyId === device.id}
              now={now}
              onRevoke={() => void revoke(device.id)}
              onVerify={() => void startRecovery(device.id)}
            />
          ))}
        </Panel>
      )}

      <SectionHead
        title="Your payment PIN"
        detail="Six digits, asked for when you send money."
      />

      <Panel>
        {pin.loading ? (
          <Text role="bodySm" tone="dim">
            Checking…
          </Text>
        ) : pin.status?.enrolled ? (
          <>
            <Text role="bodyMedium">Your PIN is set</Text>

            {/*
              A locked PIN is stated here rather than discovered at the till.

              Without this line, the first a user learns of a lockout is a payment they cannot
              complete — and the message arrives on a screen built for confirming a transfer, not
              for explaining a security state. Naming it here, with the route out beside it, turns
              a dead end into a task.
            */}
            {pin.status.locked ? (
              <Text role="bodySm" tone="carmine" style={styles.pinLine}>
                It is locked after too many incorrect attempts. Reset it to send
                money again.
              </Text>
            ) : (
              <Text role="bodySm" tone="dim" style={styles.pinLine}>
                Payments under ₹{PIN_EXEMPT_BELOW_RUPEES} do not ask for it, so
                small everyday payments stay quick.
              </Text>
            )}

            <Button
              label={pin.status.locked ? 'Reset my PIN' : 'Change my PIN'}
              onPress={() => router.push(ROUTES.SECURITY.PIN_CHANGE)}
              variant="secondary"
            />
          </>
        ) : (
          <>
            <Text role="bodyMedium">You have not set a PIN yet</Text>
            {/*
              Says what the PIN BUYS, not that it is required.

              A user who is told "set a PIN for security" has been given a chore. One who is told
              a code sent to this phone is no protection if somebody is holding this phone has been
              given the actual reason — and it is a reason they can check against their own
              experience of losing a handset.
            */}
            <Text role="bodySm" tone="dim" style={styles.pinLine}>
              Without one, we confirm payments with a code sent to this phone —
              which protects you less, because anyone holding your phone can read
              it. A PIN is something only you know.
            </Text>
            <Button
              label="Set a PIN"
              onPress={() => router.push(ROUTES.SECURITY.PIN)}
            />
          </>
        )}
      </Panel>

      <SectionHead title="Activity" />

      <Panel>
        <Text role="bodySm" tone="dim">
          Every security decision we make about your account, and why. Including the ones
          you never noticed.
        </Text>
        <Button
          label="See my security activity"
          onPress={() => router.push(ROUTES.SECURITY.ACTIVITY)}
          variant="secondary"
        />
      </Panel>

      {/*
        The honest footnote about what this screen cannot do.

        Stated rather than omitted, because a security screen that implies more protection
        than it provides is worse than one that admits its edge. A user who knows the SIM
        check needs their carrier understands why an iPhone shows fewer protections than an
        Android — and does not read the difference as the app being broken on their phone.
      */}
      <Micro tone="faint" style={styles.footnote}>
        We also watch for SIM changes on your number. On some phones the SIM cannot be
        checked directly, so we rely on your carrier telling us.
      </Micro>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: Space.md, marginBottom: Space.xxl },
  empty: { marginTop: Space.md },
  pinLine: { marginTop: Space.md, marginBottom: Space.md },
  footnote: { marginTop: Space.xxl },
});
