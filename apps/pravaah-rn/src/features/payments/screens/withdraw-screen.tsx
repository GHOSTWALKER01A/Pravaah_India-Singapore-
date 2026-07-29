import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Header,
  Legend,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { Space, usePalette } from '@/theme';

import {
  beneficiaryService,
  paymentsService,
} from '@/api/payments/services';
import type { BeneficiaryView, MoneyView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { AmountField } from '@/features/payments/components';
import {
  amountFromMinor,
  amountToMinor,
  emptyAmount,
  isAmountEmpty,
  minorExceeds,
  type AmountEntry,
} from '@/features/payments/money';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

/**
 * Withdraw to your own bank account.
 *
 * No quote, and that is correct rather than a shortcut: same currency, no fee, so the price is the
 * identity function and there is nothing to lock. It still runs the ordinary saga — reserve, submit,
 * settle — so the money is held rather than vanished if the rail is slow, and the receipt is the
 * same counterfoil as any other payment.
 *
 * The balance ceiling is checked against the WALLET rather than the corridor cap, because that is
 * the binding constraint here and quoting a daily limit at somebody trying to withdraw ₹200 they do
 * not have would be answering a question they did not ask.
 */
export function WithdrawScreen() {
  const router = useRouter();
  const p = usePalette();

  const [destinations, setDestinations] = useState<BeneficiaryView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [balance, setBalance] = useState<MoneyView | null>(null);
  const [entry, setEntry] = useState<AmountEntry>(emptyAmount);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { key: idempotencyKey } = useIdempotencyKey();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [page, wallet] = await Promise.all([
          beneficiaryService.list({ limit: 100 }),
          paymentsService.wallet(),
        ]);
        if (!alive) return;
        const own = page.items.filter(
          (payee) => payee.isSelf && payee.status === 'VERIFIED',
        );
        setDestinations(own);
        setSelected(own[0]?.id ?? null);
        setBalance(wallet.balances.find((b) => b.currency === 'INR') ?? null);
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : 'Could not load your accounts.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const minor = amountToMinor(entry);
  const overBalance =
    balance !== null && !isAmountEmpty(entry) && minorExceeds(minor, balance.minor);
  const canSend = selected !== null && !isAmountEmpty(entry) && !overBalance && !busy;

  const onWithdraw = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const created = await paymentsService.withdraw(idempotencyKey, {
        destBeneficiaryId: selected,
        amountMinor: minor,
        currency: 'INR',
      });
      haptic.commit();
      router.replace(ROUTES.PAY.RECEIPT(created.id));
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof Error
          ? caught.message
          : 'That withdrawal could not be started. Nothing has left your wallet.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Withdraw' }} />
        <View style={styles.centre}>
          <Spinner label="Loading your accounts" />
        </View>
      </Screen>
    );
  }

  if (destinations.length === 0) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Withdraw' }} />
        <Header title="Withdraw" lede="Money goes out to an account you have proven is yours." />
        <Notice tone="caution" title="No verified account of your own yet">
          Add your own bank account as a payee and mark it as yours. Withdrawals only ever go to
          an account we have checked belongs to you — that restriction is what stops a
          compromised account being drained to a stranger.
        </Notice>
        <Button
          label="Add my own account"
          icon="plus"
          onPress={() => router.push(ROUTES.PAY.PAYEE_ADD)}
        />
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      footer={
        <Button
          label={busy ? 'Sending…' : 'Withdraw'}
          onPress={onWithdraw}
          disabled={!canSend}
          loading={busy}
          hint={overBalance ? 'More than your wallet holds' : undefined}
        />
      }
    >
      <Stack.Screen options={{ title: 'Withdraw' }} />

      <Header
        title="Withdraw"
        lede="Move money from your Pravaah wallet to your own bank account."
      />

      {balance ? (
        <View style={styles.balanceRow}>
          <Micro>Available to withdraw</Micro>
          <Text role="valueSm">{balance.formatted}</Text>
        </View>
      ) : null}

      <View style={styles.block}>
        <Legend small>To</Legend>
        <Panel pad="none" notch>
          {destinations.map((destination, index) => (
            <View key={destination.id}>
              {index > 0 ? <Rule /> : null}
              <Press
                onPress={() => setSelected(destination.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: selected === destination.id }}
                accessibilityLabel={`${destination.registeredName ?? destination.displayName}, ${destination.handle}`}
              >
                <View
                  style={[
                    styles.row,
                    selected === destination.id && { backgroundColor: p.fieldWash },
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text role="bodyMedium">
                      {destination.registeredName ?? destination.displayName}
                    </Text>
                    <Micro>{destination.handle}</Micro>
                  </View>
                  {selected === destination.id ? (
                    <Text role="bodySmMedium" style={{ color: p.cleared }}>
                      Selected
                    </Text>
                  ) : null}
                </View>
              </Press>
            </View>
          ))}
        </Panel>
      </View>

      <AmountField
        entry={entry}
        onChange={setEntry}
        currency="INR"
        label="How much"
        autoFocus
      />

      {balance ? (
        <Button
          label={`Withdraw everything (${balance.formatted})`}
          variant="quiet"
          onPress={() => setEntry(amountFromMinor(balance.minor, balance.currency))}
        />
      ) : null}

      {overBalance ? (
        <Notice tone="caution" title="More than you have">
          Your wallet holds {balance?.formatted}. Withdraw that or less.
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="error" title="Not sent">
          {error}
        </Notice>
      ) : null}

      <Micro>
        No fee. This goes out over UPI and usually arrives in seconds. If the network cannot
        confirm it we hold the money rather than guessing, and you will see it as
        &ldquo;still confirming&rdquo; rather than lost.
      </Micro>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  block: { gap: Space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  words: { fontStyle: 'italic', minHeight: 34 },
});
