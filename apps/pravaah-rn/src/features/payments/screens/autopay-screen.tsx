import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Header,
  Icon,
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

import { mandateService } from '@/api/payments/services';
import type { MandateView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { MANDATE_FREQUENCY } from '@/features/payments/meta';

/**
 * AutoPay mandates — every standing permission to debit.
 *
 * The list leads with the CEILING and the NEXT DEBIT DATE, not the merchant's name. That is the
 * inversion that matters: a user opening this screen is asking "what can be taken from me, and
 * when", and a list of brand names answers neither. Every row states the authorised maximum, because
 * a permission the user cannot quantify is one they cannot meaningfully have consented to.
 */
export function AutopayScreen() {
  const router = useRouter();
  const p = usePalette();

  const [mandates, setMandates] = useState<MandateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await mandateService.list({ limit: 50 });
      setMandates(page.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your mandates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = mandates.filter((m) => m.status === 'ACTIVE' || m.status === 'PENDING');
  const dormant = mandates.filter((m) => m.status !== 'ACTIVE' && m.status !== 'PENDING');

  return (
    <Screen scroll onRefresh={load} refreshing={false}>
      <Stack.Screen options={{ title: 'AutoPay' }} />

      <Header
        title="AutoPay"
        lede="Standing permissions that let somebody debit you without you being there."
      />

      {error ? (
        <Notice tone="error" title="Could not load" action="Try again" onAction={load}>
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <ListSkeleton rows={3} label="Loading your mandates" />
      ) : mandates.length === 0 ? (
        <View style={[styles.empty, { borderColor: p.rule }]}>
          <Text role="bodySm" tone="dim" center>
            No standing permissions.
          </Text>
          <Micro center>
            AutoPay is for a bill or a loan repayment you want taken automatically. You set a
            ceiling, and nothing above it can ever be debited. We notify you at least 24 hours
            before every single debit.
          </Micro>
        </View>
      ) : (
        <>
          {live.length > 0 ? (
            <Panel pad="none" notch>
              {live.map((mandate, index) => (
                <View key={mandate.id}>
                  {index > 0 ? <Rule /> : null}
                  <MandateRow
                    mandate={mandate}
                    onPress={() => router.push(ROUTES.PAY.AUTOPAY_DETAIL(mandate.id))}
                  />
                </View>
              ))}
            </Panel>
          ) : null}

          {dormant.length > 0 ? (
            <View style={styles.block}>
              <Micro>Ended or cancelled</Micro>
              <Panel pad="none" notch>
                {dormant.map((mandate, index) => (
                  <View key={mandate.id}>
                    {index > 0 ? <Rule /> : null}
                    <MandateRow
                      mandate={mandate}
                      onPress={() => router.push(ROUTES.PAY.AUTOPAY_DETAIL(mandate.id))}
                    />
                  </View>
                ))}
              </Panel>
            </View>
          ) : null}
        </>
      )}

      <Button
        label="Set up AutoPay"
        icon="plus"
        variant="secondary"
        onPress={() => router.push(ROUTES.PAY.AUTOPAY_NEW)}
      />

      <Micro>
        Every AutoPay debit is announced to you at least 24 hours ahead — that is an NPCI rule
        and we will not execute a debit that was not notified. Cancelling is permanent; pausing
        is not.
      </Micro>
    </Screen>
  );
}

function MandateRow({
  mandate,
  onPress,
}: {
  mandate: MandateView;
  onPress: () => void;
}) {
  const p = usePalette();
  const frequency = MANDATE_FREQUENCY[mandate.frequency];

  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Up to ${mandate.maxAmount.formatted}, ${frequency.label.toLowerCase()}, ${mandate.status.toLowerCase()}`}
    >
      <View style={styles.row}>
        <View style={styles.rowText}>
          {/* The ceiling first. It is what the user authorised and what bounds the risk. */}
          <Text role="bodyMedium" numberOfLines={1}>
            {mandate.amountRule === 'MAX' ? 'Up to ' : ''}
            {mandate.maxAmount.formatted} · {frequency.label.toLowerCase()}
          </Text>
          <Micro numberOfLines={1}>
            {mandate.narration ?? mandate.purposeCode}
          </Micro>
          {mandate.nextDebitAt && mandate.status === 'ACTIVE' ? (
            <Micro style={{ color: p.latent }}>
              Next debit{' '}
              {new Date(mandate.nextDebitAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
              })}
            </Micro>
          ) : null}
        </View>
        <View style={styles.rowEnd}>
          <StatusMark status={mandate.status} labelled size={11} />
          <Icon name="chevronRight" size={13} color={p.inkFaint} />
        </View>
      </View>
    </Press>
  );
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
