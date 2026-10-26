import { StyleSheet, View } from 'react-native';

import type { ShareReceipt } from '@/api';
import { Icon, Micro, Press, StatusMark, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import {
  daysUntil,
  formatDate,
  formatWhen,
  isYesNoClaim,
  partnerTypeLabel,
  sharedSummary,
} from '../share-meta';

/**
 * One consent receipt in the list.
 *
 * The second line answers the question a holder scanning this list actually has — "do
 * they still have it?" — rather than repeating the purpose, which is on the receipt.
 * An organisation PRAVAAH has stopped vouching for is keylined carmine here, not only on
 * the detail screen: it is the strongest reason to withdraw, and it should be visible
 * before the holder chooses which row to open.
 */
export function ShareRow({ receipt, onPress }: { receipt: ShareReceipt; onPress: () => void }) {
  const p = usePalette();
  const answers = receipt.claimsShared.filter((item) => isYesNoClaim(item.claim)).length;
  const flagged = receipt.status === 'ACTIVE' && !receipt.partner.stillApproved;

  const holding =
    receipt.status === 'WITHDRAWN'
      ? `Withdrawn ${formatDate(receipt.withdrawnAt)}`
      : receipt.status === 'EXPIRED'
        ? `Deleted ${formatDate(receipt.dataDeletedAt ?? receipt.deletesOn)}`
        : `Kept for ${daysUntil(receipt.deletesOn)} more ${daysUntil(receipt.deletesOn) === 1 ? 'day' : 'days'}`;

  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`${receipt.partner.name}, ${partnerTypeLabel(receipt.partner.type)}. Shared ${formatWhen(receipt.issuedAt)}. ${sharedSummary(receipt.claimsShared.length, answers)}. ${holding}.`}
    >
      <View
        style={[
          styles.row,
          flagged
            ? { borderColor: p.carmine, backgroundColor: p.carmineWash }
            : { borderColor: p.rule, backgroundColor: p.panel },
        ]}
      >
        <View style={styles.text}>
          <View style={styles.head}>
            <Text role="title" style={styles.name} numberOfLines={1}>
              {receipt.partner.name}
            </Text>
            <StatusMark status={receipt.status} size={14} />
          </View>
          <Micro tone="dim">
            {partnerTypeLabel(receipt.partner.type)} · {formatWhen(receipt.issuedAt)} ·{' '}
            {sharedSummary(receipt.claimsShared.length, answers)}
          </Micro>
          <Micro tone={flagged ? 'carmine' : 'faint'}>
            {flagged ? 'No longer vouched for by Pravaah · ' : ''}
            {holding}
          </Micro>
        </View>
        <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  text: { flex: 1, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  name: { flexShrink: 1 },
});
