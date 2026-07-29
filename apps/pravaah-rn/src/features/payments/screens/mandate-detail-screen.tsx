import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  FieldGrid,
  FieldRow,
  Header,
  Legend,
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

import { mandateService } from '@/api/payments/services';
import type { MandateDetail } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { AmountLine } from '@/features/payments/components';
import { MANDATE_FREQUENCY, PURPOSE_LABEL } from '@/features/payments/meta';

import type { PurposeCode } from '@/api/payments/schemas';

/**
 * One mandate, and its debit history.
 *
 * The history shows SKIPPED and FAILED rows alongside successful debits, which is the answer to the
 * question users actually bring here: "why wasn't I charged last month?" Hiding a skipped debit makes
 * that unanswerable, and the reason is usually something they can fix.
 *
 * `notifiedAt` is on every row, because the 24-hour notice is a promise made to the user and showing
 * when it was sent is how they hold us to it. A debit with no notification timestamp is one that
 * should never have run.
 */
export function MandateDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const p = usePalette();

  const [mandate, setMandate] = useState<MandateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'PAUSE' | 'RESUME' | 'REVOKE' | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMandate(await mandateService.detail(id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this mandate.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: 'PAUSE' | 'RESUME' | 'REVOKE') => {
    setBusy(action);
    setError(null);
    try {
      await mandateService.act(id, action);
      if (action === 'REVOKE') haptic.destroy();
      else haptic.select();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setBusy(null);
      setConfirmRevoke(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'AutoPay' }} />
        <View style={styles.centre}>
          <Spinner label="Loading this mandate" />
        </View>
      </Screen>
    );
  }

  if (!mandate) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'AutoPay' }} />
        <Notice tone="error" title="Could not find this mandate">
          {error ?? 'That mandate does not exist, or is not yours.'}
        </Notice>
      </Screen>
    );
  }

  const frequency = MANDATE_FREQUENCY[mandate.frequency];
  const active = mandate.status === 'ACTIVE';
  const paused = mandate.status === 'PAUSED';
  const ended = ['REVOKED', 'COMPLETED', 'EXPIRED', 'FAILED'].includes(mandate.status);

  return (
    <Screen scroll onRefresh={load} refreshing={false}>
      <Stack.Screen options={{ title: 'AutoPay' }} />

      <Header
        legend="Standing permission"
        title={mandate.payee.registeredName ?? mandate.payee.displayName}
        aside={<StatusMark status={mandate.status} labelled />}
      />

      {mandate.status === 'PENDING' ? (
        <Notice tone="caution" title="Not active yet">
          You still need to approve this in your own bank&apos;s UPI app. Nothing can be debited
          until you do.
        </Notice>
      ) : null}

      {/* The ceiling, as the plate's hero. It is the whole bound on this permission. */}
      <View style={[styles.plate, { borderColor: p.ruleStrong, backgroundColor: p.panel }]}>
        <AmountLine
          minor={mandate.maxAmount.minor}
          currency={mandate.maxAmount.currency}
          formatted={mandate.maxAmount.formatted}
          label={
            mandate.amountRule === 'MAX'
              ? 'Most that can be taken, each time'
              : 'Exact amount, each time'
          }
        />
      </View>

      <Panel pad="none" notch>
        <FieldGrid>
          <FieldRow label="How often" value={frequency.label} />
          <FieldRow
            label="For"
            value={PURPOSE_LABEL[mandate.purposeCode as PurposeCode] ?? mandate.purposeCode}
          />
          {mandate.nextDebitAt && active ? (
            <FieldRow
              label="Next debit"
              value={new Date(mandate.nextDebitAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            />
          ) : null}
          <FieldRow
            label="Runs until"
            value={new Date(mandate.validUntil).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          />
          {mandate.umn ? <FieldRow label="Mandate number" value={mandate.umn} /> : null}
          {mandate.revokeReason ? (
            <FieldRow label="Cancelled because" value={mandate.revokeReason} prose />
          ) : null}
          {mandate.failureReason ? (
            <FieldRow label="Problem" value={mandate.failureReason} prose />
          ) : null}
        </FieldGrid>
      </Panel>

      {error ? (
        <Notice tone="error" title="That did not work">
          {error}
        </Notice>
      ) : null}

      {/* ── ACTIONS ─────────────────────────────────────────────────────── */}
      {!ended ? (
        <View style={styles.actions}>
          {active ? (
            <Button
              label={busy === 'PAUSE' ? 'Pausing…' : 'Pause'}
              variant="secondary"
              loading={busy === 'PAUSE'}
              onPress={() => act('PAUSE')}
              hint="Stops debits for now. You can resume it later."
            />
          ) : null}
          {paused ? (
            <Button
              label={busy === 'RESUME' ? 'Resuming…' : 'Resume'}
              variant="secondary"
              loading={busy === 'RESUME'}
              onPress={() => act('RESUME')}
            />
          ) : null}

          {confirmRevoke ? (
            <View style={[styles.confirmBox, { borderColor: p.carmine }]}>
              <Text role="bodySmMedium" style={{ color: p.carmine }}>
                Cancel this AutoPay permanently?
              </Text>
              <Micro>
                Cancelling cannot be undone — you would have to set it up and approve it again
                from scratch. If you only want to stop debits for a while, pause it instead.
              </Micro>
              <View style={styles.confirmRow}>
                <Button
                  label={busy === 'REVOKE' ? 'Cancelling…' : 'Yes, cancel it'}
                  variant="destructive"
                  loading={busy === 'REVOKE'}
                  onPress={() => act('REVOKE')}
                  inline
                />
                <Button
                  label="Keep it"
                  variant="quiet"
                  onPress={() => setConfirmRevoke(false)}
                  inline
                />
              </View>
            </View>
          ) : (
            <Button
              label="Cancel AutoPay"
              variant="destructive"
              onPress={() => setConfirmRevoke(true)}
              hint="Permanent. Pausing is reversible."
            />
          )}
        </View>
      ) : null}

      {/* ── DEBIT HISTORY ───────────────────────────────────────────────── */}
      {mandate.debits.length > 0 ? (
        <View style={styles.block}>
          <Legend small>Debits</Legend>
          <Panel pad="none" notch>
            <FieldGrid>
              {mandate.debits.map((debit) => (
                <FieldRow
                  key={debit.sequence}
                  label={`${new Date(debit.dueAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })} · ${debitLabel(debit.status)}`}
                  value={debit.amount.formatted}
                />
              ))}
            </FieldGrid>
          </Panel>
          {/*
            The notice promise, evidenced. A user asking "was I warned?" gets an answer rather
            than an assurance.
          */}
          <Micro>
            {mandate.debits.filter((d) => d.notifiedAt).length} of {mandate.debits.length}{' '}
            debits were announced to you at least 24 hours ahead. We do not execute a debit that
            was not.
          </Micro>
          {mandate.debits.some((d) => d.failureReason) ? (
            <Micro style={{ color: p.carmine }}>
              {mandate.debits.find((d) => d.failureReason)?.failureReason}
            </Micro>
          ) : null}
        </View>
      ) : null}

      <Button
        label="All AutoPay mandates"
        variant="quiet"
        onPress={() => router.replace(ROUTES.PAY.AUTOPAY)}
      />
    </Screen>
  );
}

/** Plain words for a debit's state. A user should not have to read `SKIPPED`. */
function debitLabel(status: string): string {
  switch (status) {
    case 'SCHEDULED':
      return 'scheduled';
    case 'NOTIFIED':
      return 'you were told';
    case 'DEBITED':
      return 'taken';
    case 'FAILED':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
    default:
      return status.toLowerCase();
  }
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  plate: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
  },
  block: { gap: Space.sm },
  actions: { gap: Space.sm },
  confirmBox: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.sm,
  },
  confirmRow: { flexDirection: 'row', gap: Space.sm, flexWrap: 'wrap' },
});
