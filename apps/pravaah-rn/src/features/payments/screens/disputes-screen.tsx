import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Header,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  StatusMark,
  Text,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import { paymentDisputeService } from '@/api/payments/services';
import type { DisputeView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { DISPUTE_KIND } from '@/features/payments/meta';

/**
 * Disputes the user has raised.
 *
 * Every row carries the SLA deadline, and that is the point of the screen. UDIR obliges a PSP to
 * answer inside a bounded window, and showing the customer the actual deadline — with the time
 * remaining, and in carmine once it has passed — is the difference between an obligation and a
 * reassurance. A support screen that said "we are looking into it" would be worse than this list.
 */
export function DisputesScreen() {
  const router = useRouter();
  const p = usePalette();

  const [disputes, setDisputes] = useState<DisputeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await paymentDisputeService.list({ limit: 50 });
      setDisputes(page.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your disputes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = disputes.filter((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW');
  const closed = disputes.filter((d) => d.status !== 'OPEN' && d.status !== 'UNDER_REVIEW');

  return (
    <Screen scroll onRefresh={load} refreshing={false}>
      <Stack.Screen options={{ title: 'Disputes' }} />

      <Header
        title="Disputes"
        lede="Payments you have reported a problem with, and where each one stands."
      />

      {error ? (
        <Notice tone="error" title="Could not load" action="Try again" onAction={load}>
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <ListSkeleton rows={3} label="Loading your disputes" />
      ) : disputes.length === 0 ? (
        <View style={[styles.empty, { borderColor: p.rule }]}>
          <Text role="bodySm" tone="dim" center>
            No disputes.
          </Text>
          <Micro center>
            If a payment goes wrong — the money left but never arrived, or you were charged twice
            — open the payment and report it. We are obliged to answer inside a fixed window and
            you will see that deadline here.
          </Micro>
        </View>
      ) : (
        <>
          {open.length > 0 ? (
            <Panel pad="none" notch>
              {open.map((dispute, index) => (
                <View key={dispute.id}>
                  {index > 0 ? <Rule /> : null}
                  <DisputeRow
                    dispute={dispute}
                    onPress={() => router.push(ROUTES.PAY.RECEIPT(dispute.transactionId))}
                  />
                </View>
              ))}
            </Panel>
          ) : null}

          {closed.length > 0 ? (
            <View style={styles.block}>
              <Micro>Resolved</Micro>
              <Panel pad="none" notch>
                {closed.map((dispute, index) => (
                  <View key={dispute.id}>
                    {index > 0 ? <Rule /> : null}
                    <DisputeRow
                      dispute={dispute}
                      onPress={() => router.push(ROUTES.PAY.RECEIPT(dispute.transactionId))}
                    />
                  </View>
                ))}
              </Panel>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function DisputeRow({
  dispute,
  onPress,
}: {
  dispute: DisputeView;
  onPress: () => void;
}) {
  const p = usePalette();
  const meta = DISPUTE_KIND[dispute.kind];
  const openStill = dispute.status === 'OPEN' || dispute.status === 'UNDER_REVIEW';
  const dueMs = Date.parse(dispute.slaDueAt) - Date.now();
  const overdue = openStill && dueMs < 0;

  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${meta.label}, ${dispute.status.toLowerCase().replace(/_/g, ' ')}`}
      accessibilityHint="Opens the payment"
    >
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text role="bodyMedium" numberOfLines={1}>
            {meta.label}
          </Text>
          <Micro numberOfLines={2}>{dispute.description}</Micro>

          {/* The deadline. In carmine once we have missed it — we do not get to hide that. */}
          {openStill ? (
            <Micro style={{ color: overdue ? p.carmine : p.latent }}>
              {overdue
                ? 'We are past our deadline on this. Chase us.'
                : `We must answer by ${new Date(dispute.slaDueAt).toLocaleString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: 'numeric',
                    month: 'short',
                  })}`}
            </Micro>
          ) : dispute.resolution ? (
            <Micro numberOfLines={3}>{dispute.resolution}</Micro>
          ) : null}
        </View>
        <StatusMark status={disputeStatusForMark(dispute.status)} labelled size={11} />
      </View>
    </Press>
  );
}

/**
 * Map a dispute status onto the shared status vocabulary.
 *
 * `RESOLVED_CREDITED` is a WIN for the customer, so it takes the cleared tone even though the word
 * "resolved" is neutral. `RESOLVED_REJECTED` takes carmine because from the customer's side it is a
 * refusal, and dressing it in a neutral tone would be softening an answer they deserve plainly.
 */
function disputeStatusForMark(status: DisputeView['status']): string {
  switch (status) {
    case 'RESOLVED_CREDITED':
      return 'COMPLETED';
    case 'RESOLVED_REJECTED':
      return 'REJECTED';
    case 'WITHDRAWN':
      return 'EXPIRED';
    case 'UNDER_REVIEW':
      return 'PENDING';
    default:
      return 'PENDING';
  }
}

const styles = StyleSheet.create({
  block: { gap: Space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
});
