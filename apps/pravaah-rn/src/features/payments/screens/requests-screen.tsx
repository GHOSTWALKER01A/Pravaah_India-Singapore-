import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Header,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  Segmented,
  StatusMark,
  Text,
  type Segment,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import { collectService } from '@/api/payments/services';
import type { CollectView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { formatCountdown } from '@/features/payments/meta';

type Side = 'RAISED' | 'RECEIVED';

/**
 * Two lists that must never merge.
 *
 * "You owe ₹500" and "you are owed ₹500" are opposite facts. A single feed of "requests" would have
 * people paying money they were expecting to receive — so the segmented control is not a filter
 * convenience, it is the thing keeping the two apart, and the service refuses to default the side
 * for the same reason.
 */
const SIDES: readonly Segment<Side>[] = [
  { value: 'RAISED', label: 'You asked' },
  { value: 'RECEIVED', label: 'Asked of you' },
];

export function RequestsScreen() {
  const router = useRouter();
  const p = usePalette();

  const [side, setSide] = useState<Side>('RAISED');
  const [items, setItems] = useState<CollectView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await collectService.list({ side, limit: 50 });
      setItems(page.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your requests.');
    } finally {
      setLoading(false);
    }
  }, [side]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    try {
      await collectService.revoke(id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel that request.');
    }
  };

  return (
    <Screen scroll onRefresh={load} refreshing={false}>
      <Stack.Screen options={{ title: 'Requests' }} />

      <Header
        title="Requests"
        lede="Money you have asked for, and money somebody has asked of you."
      />

      <Segmented segments={SIDES} value={side} onChange={setSide} label="Which side" />

      {error ? (
        <Notice tone="error" title="Could not load" action="Try again" onAction={load}>
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <ListSkeleton rows={4} label="Loading requests" />
      ) : items.length === 0 ? (
        <View style={[styles.empty, { borderColor: p.rule }]}>
          <Text role="bodySm" tone="dim" center>
            {side === 'RAISED' ? 'You have not asked anyone for money.' : 'Nobody has asked you for money.'}
          </Text>
          <Micro center>
            {side === 'RAISED'
              ? 'A request goes to their UPI app, where they approve or decline it. Nothing moves until they do.'
              : 'When somebody requests money from you it appears here, and you approve it in your own bank app — never here.'}
          </Micro>
        </View>
      ) : (
        <Panel pad="none" notch>
          {items.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Rule /> : null}
              <RequestRow
                request={item}
                side={side}
                onOpenPayment={
                  item.transactionId
                    ? () => router.push(ROUTES.PAY.RECEIPT(item.transactionId!))
                    : undefined
                }
                onRevoke={
                  side === 'RAISED' && item.isOpen ? () => revoke(item.id) : undefined
                }
              />
            </View>
          ))}
        </Panel>
      )}

      {side === 'RAISED' ? (
        <Button
          label="Request money"
          icon="receipt"
          variant="secondary"
          onPress={() => router.push(ROUTES.PAY.REQUEST)}
        />
      ) : (
        <Micro>
          You approve a request inside your own bank&apos;s UPI app, using your UPI PIN. Pravaah
          never sees that PIN and cannot approve a debit on your behalf — which is why there is no
          button here to do it.
        </Micro>
      )}
    </Screen>
  );
}

function RequestRow({
  request,
  side,
  onOpenPayment,
  onRevoke,
}: {
  request: CollectView;
  side: Side;
  onOpenPayment?: () => void;
  onRevoke?: () => void;
}) {
  const p = usePalette();

  const body = (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text role="bodyMedium" numberOfLines={1}>
          {request.amount.formatted}
        </Text>
        <Micro numberOfLines={1}>
          {side === 'RAISED' ? 'from ' : 'to '}
          {request.payerName ?? request.payer}
          {request.narration ? ` · ${request.narration}` : ''}
        </Micro>
        {request.isOpen ? (
          <Micro style={{ color: p.latent }}>
            Expires in {formatCountdown(request.expiresInMs)}
          </Micro>
        ) : request.declineReason ? (
          <Micro style={{ color: p.carmine }}>{request.declineReason}</Micro>
        ) : null}
      </View>

      <View style={styles.rowEnd}>
        <StatusMark status={request.status} labelled size={11} />
        {onRevoke ? (
          <Button label="Cancel" variant="quiet" onPress={onRevoke} inline />
        ) : null}
      </View>
    </View>
  );

  if (!onOpenPayment) return body;
  return (
    <Press
      onPress={onOpenPayment}
      accessibilityRole="button"
      accessibilityLabel={`${request.amount.formatted}, ${request.status.toLowerCase()}`}
      accessibilityHint="Opens the payment"
    >
      {body}
    </Press>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  rowEnd: { flexShrink: 0, alignItems: 'flex-end', gap: Space.xs },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
});
