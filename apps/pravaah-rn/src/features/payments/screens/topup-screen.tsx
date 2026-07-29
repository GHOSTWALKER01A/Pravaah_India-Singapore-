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
import type { BeneficiaryView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { AmountField } from '@/features/payments/components';
import {
  amountToMinor,
  emptyAmount,
  isAmountEmpty,
  type AmountEntry,
} from '@/features/payments/money';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

/**
 * Add money — a UPI collect raised against the user's OWN account.
 *
 * The flow is honest about what it is rather than presenting a fake "instant top-up": we raise a
 * request against an account the user has proven is theirs, they approve it in their bank's app with
 * their UPI PIN, and the wallet is credited when the rail confirms the debit. There is no path here
 * where Pravaah moves money out of somebody's bank on its own authority, and the copy says so.
 *
 * Only own-account payees are offered. The server enforces it, but showing every payee and then
 * refusing would suggest the restriction is arbitrary — it is the difference between adding your own
 * money and pulling somebody else's.
 */
export function TopupScreen() {
  const router = useRouter();
  const p = usePalette();

  const [sources, setSources] = useState<BeneficiaryView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entry, setEntry] = useState<AmountEntry>(emptyAmount);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [raised, setRaised] = useState<{ amount: string; expiresAt: string } | null>(null);

  const { key: idempotencyKey } = useIdempotencyKey();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const page = await beneficiaryService.list({ limit: 100 });
        if (!alive) return;
        const own = page.items.filter(
          (payee) => payee.isSelf && payee.status === 'VERIFIED',
        );
        setSources(own);
        setSelected(own[0]?.id ?? null);
      } catch (caught) {
        if (!alive) return;
        setError(
          caught instanceof Error ? caught.message : 'Could not load your accounts.',
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const minor = amountToMinor(entry);
  const canSend = selected !== null && !isAmountEmpty(entry) && !busy;

  const onAdd = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await paymentsService.topup(idempotencyKey, {
        sourceBeneficiaryId: selected,
        amountMinor: minor,
        currency: 'INR',
      });
      haptic.commit();
      setRaised({ amount: result.amount.formatted, expiresAt: result.expiresAt });
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof Error ? caught.message : 'Could not raise that request.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Add money' }} />
        <View style={styles.centre}>
          <Spinner label="Loading your accounts" />
        </View>
      </Screen>
    );
  }

  // ── after the request is raised ──────────────────────────────────────────
  if (raised) {
    return (
      <Screen scroll footer={<Button label="Done" onPress={() => router.back()} />}>
        <Stack.Screen options={{ title: 'Approve it in your bank app' }} />
        <Header
          title="Now approve it"
          lede={`We have asked your bank for ${raised.amount}. Open your UPI app to approve it with your PIN.`}
        />
        <Notice tone="caution" title="This is the part only you can do">
          Pravaah never sees your UPI PIN, so we cannot approve this for you. Your bank will
          show the request in whichever UPI app you normally use.
        </Notice>
        <Micro>
          The request expires at{' '}
          {new Date(raised.expiresAt).toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          . Your wallet is credited only once your bank confirms the debit — not when you tap
          approve, because a bank can still decline after that.
        </Micro>
        <Button
          label="See my requests"
          variant="secondary"
          onPress={() => router.replace(ROUTES.PAY.REQUESTS)}
        />
      </Screen>
    );
  }

  // ── no own account on file ───────────────────────────────────────────────
  if (sources.length === 0) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Add money' }} />
        <Header
          title="Add money"
          lede="Money comes in from an account you have proven is yours."
        />
        <Notice tone="caution" title="No verified account of your own yet">
          Add your own bank account or UPI ID as a payee and mark it as yours. We check it
          against the account you verified when you signed up — that is what makes it safe to
          pull money from without asking you every time.
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
          label={busy ? 'Asking your bank…' : 'Request the money'}
          onPress={onAdd}
          disabled={!canSend}
          loading={busy}
        />
      }
    >
      <Stack.Screen options={{ title: 'Add money' }} />

      <Header
        title="Add money"
        lede="We ask your bank; you approve it in your own UPI app."
      />

      <View style={styles.block}>
        <Legend small>From</Legend>
        <Panel pad="none" notch>
          {sources.map((source, index) => (
            <View key={source.id}>
              {index > 0 ? <Rule /> : null}
              <Press
                onPress={() => setSelected(source.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: selected === source.id }}
                accessibilityLabel={`${source.registeredName ?? source.displayName}, ${source.handle}`}
              >
                <View
                  style={[
                    styles.sourceRow,
                    selected === source.id && { backgroundColor: p.fieldWash },
                  ]}
                >
                  <View style={styles.sourceText}>
                    <Text role="bodyMedium">
                      {source.registeredName ?? source.displayName}
                    </Text>
                    <Micro>{source.handle}</Micro>
                  </View>
                  {selected === source.id ? (
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

      {error ? (
        <Notice tone="error" title="Could not do that">
          {error}
        </Notice>
      ) : null}

      <Micro>
        No fee to add money. The amount appears in your wallet once your bank confirms the
        debit, which is usually seconds.
      </Micro>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  block: { gap: Space.sm },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  sourceText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  words: { fontStyle: 'italic', minHeight: 34 },
});
