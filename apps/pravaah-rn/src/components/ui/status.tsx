/**
 * Status, in the note's own two-colour system.
 *
 * The incumbent mapped 17 API states onto four unrelated hues — success green,
 * warning amber, danger red, info blue — inside a product whose brand colour is
 * green. So a PASSED check and the brand field were the same colour by accident,
 * a blue "in progress" belonged to no palette at all, and the pill was a
 * `${color}22` wash with a dot: identical geometry for every state, so colour was
 * the ONLY carrier of meaning.
 *
 * Here every state resolves to one of four tones, each with a distinct seal shape,
 * and the label always ships alongside. See DESIGN.md for the tone assignment.
 */
import { StyleSheet, View } from 'react-native';

import { STATUS_TONE, Space, toneColor, toneOnField, usePalette } from '@/theme';
import type { StatusTone } from '@/theme';

import { Seal } from './seal';
import { Text } from './text';
import type { Surface } from './text';

/**
 * Every status string the API can return, across KYC profiles, individual checks,
 * consents and data sessions — the union the old `KYC_STATUS_META` covered, with
 * the same labels, re-toned.
 *
 * `live` marks the states where a machine is genuinely working right now, and is
 * the only thing that animates a seal. `IN_REVIEW` and `MANUAL_REVIEW` are
 * deliberately NOT live: a person is looking, and a spinner would imply the system
 * is about to finish when it might be hours.
 */
export const STATUS_META: Record<
  string,
  { label: string; tone: StatusTone; live?: boolean }
> = {
  // Profile-level
  NOT_STARTED: { label: 'Not started', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'latent' },
  IN_REVIEW: { label: 'In review', tone: 'latent' },
  ACTION_REQUIRED: { label: 'Action needed', tone: 'latent' },
  VERIFIED: { label: 'Verified', tone: 'field' },
  REJECTED: { label: 'Declined', tone: 'carmine' },

  // Per-check
  PASSED: { label: 'Passed', tone: 'field' },
  FAILED: { label: 'Failed', tone: 'carmine' },
  PENDING: { label: 'Checking', tone: 'latent', live: true },
  MANUAL_REVIEW: { label: 'In review', tone: 'latent' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },

  // Consent lifecycle + data session
  ACTIVE: { label: 'Active', tone: 'field' },
  PAUSED: { label: 'Paused', tone: 'latent' },
  REVOKED: { label: 'Revoked', tone: 'carmine' },
  COMPLETED: { label: 'Complete', tone: 'field' },
  PARTIAL: { label: 'Partial', tone: 'latent' },

  /**
   * M6 device lifecycle. `ACTIVE` and `REVOKED` are already above and mean the same thing
   * for a device as for a consent, so only the two new states are added here.
   *
   * They are added rather than left to `statusMeta`'s fallback because that fallback renders
   * the RAW TOKEN — a user would have read the words "SUSPECTED_SWAP" on their own device
   * list, which is both meaningless and alarming. The fallback exists so an unknown status
   * degrades instead of crashing, not as a licence to skip the copy.
   */
  BINDING: { label: 'Not finished', tone: 'neutral' },
  SUSPECTED_SWAP: { label: 'Needs verifying', tone: 'latent' },

  /**
   * M7 consent receipts and verifier requests. `ACTIVE` and `EXPIRED` above already read
   * right for a receipt. WITHDRAWN is neutral, not carmine: withdrawing is the holder
   * exercising control, not something going wrong, and red would make the safe action look
   * like a failure.
   */
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, tone: 'neutral' as StatusTone };
}

/**
 * The seal plus its label.
 *
 * Not a filled pill. A pill is a badge; a seal is what a document carries, and it
 * lets the four states differ in shape rather than only in wash colour.
 */
export function StatusMark({
  status,
  surface = 'sheet',
  /** Hide the label where the row already names the state in prose. */
  labelled = true,
  size = 16,
}: {
  status: string;
  surface?: Surface;
  labelled?: boolean;
  size?: number;
}) {
  const p = usePalette();
  const meta = statusMeta(status);
  const ink =
    surface === 'field' ? toneOnField(meta.tone, p) : toneColor(meta.tone, p).ink;

  return (
    <View
      style={styles.mark}
      // One node, one announcement. Without this the seal and the label are read
      // as two separate items, and the seal has no text at all.
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Status: ${meta.label}`}
    >
      <Seal
        shape={STATUS_TONE[meta.tone]}
        size={size}
        color={ink}
        voidColor={surface === 'field' ? p.field : p.ground}
        live={meta.live}
      />
      {labelled ? (
        <Text role="legendSm" tone="inherit" surface={surface} style={{ color: ink }}>
          {meta.label.toUpperCase()}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // `flexShrink: 0`: in a tight row the neighbouring label gives way, never the
  // status. A half-cut "VERIFIED" is worse than a truncated caption.
  mark: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, flexShrink: 0 },
});
