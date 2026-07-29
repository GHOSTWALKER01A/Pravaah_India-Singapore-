import { StyleSheet, View } from 'react-native';

import {
  Button,
  Icon,
  Micro,
  Rule,
  StatusMark,
  Text,
} from '@/components/ui';
import { Space, usePalette } from '@/theme';

import type { DeviceView } from '@/api/security/schemas';

import {
  DEVICE_INTEGRITY,
  DEVICE_STATUS,
  formatCoolingOff,
  formatLastSeen,
} from '../security-meta';

/**
 * One registered device, with the one action that matters.
 *
 * ## Why "This wasn't me" is the primary action and has no confirmation dialog
 *
 * Revoking is the SAFE direction. The failure mode of an accidental revoke is that the user
 * signs in again on that phone; the failure mode of a revoke made HARDER is a takeover that
 * proceeds while somebody hunts for a confirmation button. So the destructive-looking action
 * is the cheap one, deliberately, and the confirmation lives in the copy ("can no longer
 * access your account") rather than in a second tap.
 *
 * The current device is the exception — see below.
 */
export function DeviceRow({
  device,
  isCurrent,
  busy,
  onRevoke,
  onVerify,
  now,
}: {
  device: DeviceView;
  isCurrent: boolean;
  busy: boolean;
  onRevoke: () => void;
  onVerify: () => void;
  now: number;
}) {
  const p = usePalette();

  const status = DEVICE_STATUS[device.status];
  const integrity = DEVICE_INTEGRITY[device.integrity];
  const coolingOff = formatCoolingOff(device.coolingOffUntil, now);

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Icon name="phone" size={20} color={p.latent} />
        <View style={styles.headText}>
          <Text role="bodyMedium">
            {labelFor(device)}
            {isCurrent ? ' · this phone' : ''}
          </Text>
          <Micro tone="faint">
            Last used {formatLastSeen(device.lastSeenAt, now)}
          </Micro>
        </View>
        {/* The seal, not a pill — the same status vocabulary the rest of the app uses. */}
        <StatusMark status={device.status} />
      </View>

      <Text role="bodySm" tone="dim" style={styles.detail}>
        {status.detail}
      </Text>

      {/*
        The cooling-off line, shown only while it is live.

        This is the single most useful sentence on the screen for a user who has just been
        challenged on a payment: it names the reason and says when it stops. Without it, the
        friction reads as the app malfunctioning.
      */}
      {coolingOff ? (
        <Micro tone="latent" style={styles.meta}>
          Larger payments need extra confirmation for {coolingOff}.
        </Micro>
      ) : null}

      {/* Surfaced rather than hidden — unexplained friction is worse than a stated cause. */}
      {integrity.detail ? (
        <Micro tone="faint" style={styles.meta}>
          {integrity.detail}
        </Micro>
      ) : null}

      <View style={styles.actions}>
        {/*
          A swap-suspected device gets the RECOVERY action first.

          Ordered ahead of removal because the common reading is a user who replaced a
          damaged SIM, and that person needs the way back — not the way out. Somebody whose
          SIM was actually stolen reaches for "This wasn't me", which is still right here.
        */}
        {device.status === 'SUSPECTED_SWAP' ? (
          <Button
            label="Verify this device"
            onPress={onVerify}
            variant="secondary"
            disabled={busy}
            inline
          />
        ) : null}

        <Button
          /*
            The label changes on the current device, and so does the consequence.

            "This wasn't me" on the phone you are holding is nonsense — you are the one
            using it. On the current device the honest action is signing this phone out,
            which is what revoking its binding does.
          */
          label={isCurrent ? 'Sign this phone out' : "This wasn't me"}
          onPress={onRevoke}
          variant="destructive"
          disabled={busy}
          inline
          hint={
            isCurrent
              ? 'Removes this phone. You will need to register it again.'
              : 'Removes this device immediately. It can no longer access your account.'
          }
        />
      </View>

      <Rule />
    </View>
  );
}

/**
 * What to call a device.
 *
 * `model` is absent on a web client and on a platform whose model string the OS withholds,
 * so the platform is the fallback. Never the device id — a uuid tells a user nothing about
 * which of their phones this is, which is the only question this line answers.
 */
function labelFor(device: DeviceView): string {
  if (device.platform === 'web') return 'Web browser';
  return device.platform === 'ios' ? 'iPhone' : 'Android phone';
}

const styles = StyleSheet.create({
  row: { gap: Space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  headText: { flexGrow: 1, flexShrink: 1 },
  detail: {},
  meta: {},
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.md,
    marginTop: Space.sm,
  },
});
