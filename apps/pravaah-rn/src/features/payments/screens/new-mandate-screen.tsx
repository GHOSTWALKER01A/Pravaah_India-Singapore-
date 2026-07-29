import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Checkbox,
  Chip,
  ChipRow,
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
import { Hairline, Space, usePalette } from '@/theme';

import { beneficiaryService, mandateService } from '@/api/payments/services';
import type {
  BeneficiaryView,
  MandateFrequency,
  PurposeCode,
} from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { AmountField } from '@/features/payments/components';
import {
  amountToMinor,
  emptyAmount,
  formatMinor,
  isAmountEmpty,
  type AmountEntry,
} from '@/features/payments/money';
import {
  DOMESTIC_PURPOSES,
  MANDATE_FREQUENCY,
  PURPOSE_LABEL,
} from '@/features/payments/meta';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

/** The recurrences worth offering. `AS_PRESENTED` is included because subscriptions use it. */
const FREQUENCIES: readonly MandateFrequency[] = [
  'MONTHLY',
  'WEEKLY',
  'QUARTERLY',
  'YEARLY',
  'AS_PRESENTED',
];

/**
 * Set up AutoPay.
 *
 * The most consequential thing a user can create in this app, so the screen is built around making
 * the BOUNDS legible rather than making setup fast:
 *
 * - **The ceiling is the hero field**, and the amount rule (exactly this / up to this) is an
 *   explicit choice rather than a default. "Up to" is what a variable bill needs and is also the
 *   riskier option, so it says which is which.
 * - **An end date is mandatory.** A permission with no end is one the user has to remember to
 *   revoke, and they will not. The screen defaults to one year and says so.
 * - **The 24-hour notice is stated as a promise**, because it is the user's actual protection and
 *   the thing that makes an unwanted debit cancellable before it happens rather than disputable
 *   after.
 */
export function NewMandateScreen() {
  const router = useRouter();
  const p = usePalette();

  const [payees, setPayees] = useState<BeneficiaryView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entry, setEntry] = useState<AmountEntry>(emptyAmount);
  const [amountRule, setAmountRule] = useState<'EXACT' | 'MAX'>('EXACT');
  const [frequency, setFrequency] = useState<MandateFrequency>('MONTHLY');
  const [purpose, setPurpose] = useState<PurposeCode>('LOAN_REPAYMENT');
  const [months, setMonths] = useState(12);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { key: idempotencyKey } = useIdempotencyKey();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const page = await beneficiaryService.list({ status: 'VERIFIED', limit: 100 });
        if (!alive) return;
        // Domestic only: there is no cross-border AutoPay on the UPI–PayNow link.
        const eligible = page.items.filter((payee) => payee.handleType !== 'PAYNOW_UPI');
        setPayees(eligible);
        setSelected(eligible[0]?.id ?? null);
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : 'Could not load your payees.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const minor = amountToMinor(entry);
  const validFrom = new Date();
  const validUntil = new Date();
  validUntil.setMonth(validUntil.getMonth() + months);

  const canCreate =
    selected !== null && !isAmountEmpty(entry) && confirmed && !busy;

  const onCreate = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const created = await mandateService.create(idempotencyKey, {
        beneficiaryId: selected,
        frequency,
        amountRule,
        maxAmountMinor: minor,
        currency: 'INR',
        purposeCode: purpose,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
        confirmedMandate: true,
      });
      haptic.commit();
      router.replace(ROUTES.PAY.AUTOPAY_DETAIL(created.id));
    } catch (caught) {
      haptic.refused();
      setError(caught instanceof Error ? caught.message : 'Could not set that up.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Set up AutoPay' }} />
        <View style={styles.centre}>
          <Spinner label="Loading your payees" />
        </View>
      </Screen>
    );
  }

  if (payees.length === 0) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Set up AutoPay' }} />
        <Header title="Set up AutoPay" />
        <Notice tone="caution" title="You need a verified payee first">
          AutoPay always names one fixed payee. Add and verify them before granting a standing
          permission — a mandate to an unverified address is a debit with nowhere to land.
        </Notice>
        <Button
          label="Add a payee"
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
          label={busy ? 'Setting up…' : 'Create the mandate'}
          onPress={onCreate}
          disabled={!canCreate}
          loading={busy}
          hint={!confirmed ? 'Confirm the ceiling and the schedule' : undefined}
        />
      }
    >
      <Stack.Screen options={{ title: 'Set up AutoPay' }} />

      <Header
        title="Set up AutoPay"
        lede="A standing permission to debit you. You set the ceiling; nothing above it can ever be taken."
      />

      <View style={styles.block}>
        <Legend small>Who gets paid</Legend>
        <Panel pad="none" notch>
          {payees.map((payee, index) => (
            <View key={payee.id}>
              {index > 0 ? <Rule /> : null}
              <Press
                onPress={() => setSelected(payee.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: selected === payee.id }}
                accessibilityLabel={payee.registeredName ?? payee.displayName}
              >
                <View
                  style={[
                    styles.row,
                    selected === payee.id && { backgroundColor: p.fieldWash },
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text role="bodyMedium">{payee.registeredName ?? payee.displayName}</Text>
                    <Micro>{payee.handle}</Micro>
                  </View>
                  {selected === payee.id ? (
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

      {/* THE CEILING — the hero field of this screen. */}
      <AmountField
        entry={entry}
        onChange={setEntry}
        currency="INR"
        label={
          amountRule === 'MAX' ? 'Most that can be taken' : 'Exact amount each time'
        }
        emptyHint="The ceiling will be written out here as you type"
      />

      <View style={styles.block}>
        <Legend small>How the amount works</Legend>
        <ChipRow>
          <Chip
            label="Exactly this, every time"
            selected={amountRule === 'EXACT'}
            onPress={() => setAmountRule('EXACT')}
          />
          <Chip
            label="Up to this"
            selected={amountRule === 'MAX'}
            onPress={() => setAmountRule('MAX')}
          />
        </ChipRow>
        <Micro>
          {amountRule === 'EXACT'
            ? 'A debit must be for exactly this amount or it is refused. Right for a fixed EMI.'
            : 'They may take any amount up to this. Right for a variable bill — and the riskier of the two, so keep the ceiling tight.'}
        </Micro>
      </View>

      <View style={styles.block}>
        <Legend small>How often</Legend>
        <ChipRow>
          {FREQUENCIES.map((code) => (
            <Chip
              key={code}
              label={MANDATE_FREQUENCY[code].label}
              selected={frequency === code}
              onPress={() => setFrequency(code)}
            />
          ))}
        </ChipRow>
        <Micro>{MANDATE_FREQUENCY[frequency].detail}</Micro>
      </View>

      <View style={styles.block}>
        <Legend small>What for</Legend>
        <ChipRow>
          {DOMESTIC_PURPOSES.map((code) => (
            <Chip
              key={code}
              label={PURPOSE_LABEL[code]}
              selected={purpose === code}
              onPress={() => setPurpose(code)}
            />
          ))}
        </ChipRow>
      </View>

      <View style={styles.block}>
        <Legend small>Until when</Legend>
        <ChipRow>
          {[6, 12, 24, 60].map((count) => (
            <Chip
              key={count}
              label={count >= 12 ? `${count / 12} year${count > 12 ? 's' : ''}` : `${count} months`}
              selected={months === count}
              onPress={() => setMonths(count)}
            />
          ))}
        </ChipRow>
        <Micro>
          Ends on{' '}
          {validUntil.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
          . An end date is required — a permission with no end is one you have to remember to
          cancel.
        </Micro>
      </View>

      {/* The signature: the ceiling and the schedule, restated for confirmation. */}
      <View style={[styles.confirm, { borderColor: p.ruleStrong }]}>
        <Checkbox
          checked={confirmed}
          onChange={setConfirmed}
          label="Confirm the ceiling and the schedule"
        >
          <Text role="bodySm">
            I authorise{' '}
            <Text role="bodySmMedium">
              {amountRule === 'MAX' ? 'up to ' : ''}
              {isAmountEmpty(entry) ? '—' : formatMinor(minor, 'INR')}
            </Text>{' '}
            to be debited {MANDATE_FREQUENCY[frequency].label.toLowerCase()} until{' '}
            {validUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.
          </Text>
        </Checkbox>
      </View>

      {error ? (
        <Notice tone="error" title="Could not set that up">
          {error}
        </Notice>
      ) : null}

      <Micro>
        You will approve this once in your own bank&apos;s UPI app — it is not active until you
        do. After that, we notify you at least 24 hours before every single debit, and a debit
        that was not notified is never executed. You can pause or cancel at any time.
      </Micro>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
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
  confirm: {
    borderTopWidth: Hairline.base,
    borderBottomWidth: Hairline.base,
    paddingVertical: Space.lg,
  },
});
