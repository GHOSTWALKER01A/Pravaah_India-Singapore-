import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  FieldGrid,
  FieldRow,
  Header,
  Micro,
  Notice,
  Panel,
  Screen,
  Spinner,
  StatusMark,
  Text,
  haptic,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { beneficiaryService } from '@/api/payments/services';
import type { BeneficiaryView } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { PayeeLine } from '@/features/payments/components';
import { formatMinor } from '@/features/payments/money';

/**
 * One payee.
 *
 * Where the name check can be re-run, and where a payee is blocked. The block/remove distinction
 * gets real copy rather than two similar buttons, because they are genuinely different acts: a
 * removed payee can be re-added in seconds with a fresh 24-hour cap, whereas a blocked one keeps
 * refusing. Somebody who has just been defrauded needs the second one, and needs to understand
 * which is which.
 */
export function PayeeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const p = usePalette();

  const [payee, setPayee] = useState<BeneficiaryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'verify' | 'block' | 'unblock' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);

  const load = useCallback(async () => {
    try {
      setPayee(await beneficiaryService.detail(id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this payee.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (
    kind: 'verify' | 'block' | 'unblock' | 'remove',
    action: () => Promise<unknown>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      if (kind === 'remove') {
        router.back();
        return;
      }
      if (kind === 'block') haptic.destroy();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
      setConfirmBlock(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Payee' }} />
        <View style={styles.centre}>
          <Spinner label="Loading this payee" />
        </View>
      </Screen>
    );
  }

  if (!payee) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Payee' }} />
        <Notice tone="error" title="Could not find this payee">
          {error ?? 'That payee does not exist, or is not yours.'}
        </Notice>
      </Screen>
    );
  }

  const blocked = payee.status === 'BLOCKED';
  const payable = payee.status === 'VERIFIED';
  const crossBorder = payee.handleType === 'PAYNOW_UPI';

  return (
    <Screen
      scroll
      footer={
        payable ? (
          <Button
            label="Pay them"
            icon="pay"
            onPress={() => router.push(ROUTES.PAY.SEND_AMOUNT(payee.id))}
          />
        ) : undefined
      }
    >
      <Stack.Screen options={{ title: payee.displayName }} />

      <Header
        title={payee.displayName}
        aside={<StatusMark status={payee.status} labelled />}
      />

      <View style={[styles.plate, { borderColor: p.ruleStrong, backgroundColor: p.panel }]}>
        <PayeeLine
          registeredName={payee.registeredName}
          handle={payee.handle}
          unreachableReason={!payable ? payee.statusReason : null}
        />
      </View>

      {/*
        The cooling period as a stated rule with its own deadline, not a warning banner. It is the
        highest-yield anti-fraud control in UPI and users are most surprised by it, so it is
        explained in terms of what it protects them from rather than as a restriction.
      */}
      {payee.coolingPeriod ? (
        <Notice tone="caution" title="New payee — capped for now">
          Payments to this payee are capped at{' '}
          {formatMinor(payee.coolingPeriod.capMinor, crossBorder ? 'SGD' : 'INR')}{' '}
          {crossBorder ? 'SGD' : 'INR'} until{' '}
          {new Date(payee.coolingPeriod.until).toLocaleString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            day: 'numeric',
            month: 'short',
          })}
          . Nearly every payment scam ends in one large transfer to somebody added minutes
          earlier, so the first day is limited. Nothing you need to do.
        </Notice>
      ) : null}

      <Panel pad="none" notch>
        <FieldGrid>
          <FieldRow
            label="Paid by"
            value={
              crossBorder
                ? 'UPI ID, over the UPI–PayNow link'
                : payee.handleType === 'ACCOUNT_IFSC'
                  ? 'Bank account and IFSC'
                  : 'UPI ID'
            }
          />
          <FieldRow label="They receive" value={payee.currency} />
          <FieldRow label="Country" value={payee.country} />
          {payee.isSelf ? <FieldRow label="Own account" value="Yes" /> : null}
          {/*
            Screening is surfaced because on the cross-border corridor it is a PRECONDITION: an
            unscreened payee cannot be paid abroad, and a user staring at a refused payment
            deserves to see which check has not completed.
          */}
          {crossBorder ? (
            <FieldRow
              label="Compliance check"
              value={payee.screened ? 'Done' : 'Not completed'}
            />
          ) : null}
          <FieldRow
            label="Name verified"
            value={
              payee.verifiedAt
                ? new Date(payee.verifiedAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })
                : 'Never'
            }
          />
          {payee.lastUsedAt ? (
            <FieldRow
              label="Last paid"
              value={new Date(payee.lastUsedAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            />
          ) : null}
        </FieldGrid>
      </Panel>

      {error ? (
        <Notice tone="error" title="That did not work">
          {error}
        </Notice>
      ) : null}

      <View style={styles.actions}>
        {!blocked ? (
          <Button
            label={busy === 'verify' ? 'Checking…' : 'Check the name again'}
            icon="refresh"
            variant="secondary"
            loading={busy === 'verify'}
            onPress={() => run('verify', () => beneficiaryService.reverify(payee.id))}
            hint="Asks their bank again. This also restarts the 24-hour cap."
          />
        ) : null}

        {blocked ? (
          <Button
            label={busy === 'unblock' ? 'Unblocking…' : 'Unblock this payee'}
            variant="secondary"
            loading={busy === 'unblock'}
            onPress={() => run('unblock', () => beneficiaryService.unblock(payee.id))}
          />
        ) : confirmBlock ? (
          // A two-step confirm rather than a modal: the destructive act is rare, and a dialog for
          // a task that needs neither interruption nor protected focus is the pattern the world
          // refuses.
          <View style={[styles.confirmBox, { borderColor: p.carmine }]}>
            <Text role="bodySmMedium" style={{ color: p.carmine }}>
              Block {payee.registeredName ?? payee.displayName}?
            </Text>
            <Micro>
              No payment will reach them again until you unblock them. Use this if somebody
              pressured you into paying them. Removing them instead would let them be added
              back in seconds.
            </Micro>
            <View style={styles.confirmRow}>
              <Button
                label={busy === 'block' ? 'Blocking…' : 'Yes, block them'}
                variant="destructive"
                loading={busy === 'block'}
                onPress={() => run('block', () => beneficiaryService.block(payee.id))}
                inline
              />
              <Button
                label="Cancel"
                variant="quiet"
                onPress={() => setConfirmBlock(false)}
                inline
              />
            </View>
          </View>
        ) : (
          <Button
            label="Block this payee"
            variant="destructive"
            onPress={() => setConfirmBlock(true)}
            hint="Stops all payments to them. Stronger than removing."
          />
        )}

        <Button
          label={busy === 'remove' ? 'Removing…' : 'Remove from my list'}
          variant="quiet"
          loading={busy === 'remove'}
          onPress={() => run('remove', () => beneficiaryService.remove(payee.id))}
          hint="Past payments keep their record. They can be added again."
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  plate: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
  },
  actions: { gap: Space.sm },
  confirmBox: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.sm,
  },
  confirmRow: { flexDirection: 'row', gap: Space.sm, flexWrap: 'wrap' },
});
