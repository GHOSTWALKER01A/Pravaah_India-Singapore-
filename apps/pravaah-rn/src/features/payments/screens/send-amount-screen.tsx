import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  Chip,
  ChipRow,
  Header,
  Legend,
  Micro,
  Notice,
  Panel,
  Screen,
  Spinner,
  TextField,
} from '@/components/ui';
import { Space, usePalette } from '@/theme';

import { beneficiaryService, paymentsService } from '@/api/payments/services';
import type {
  BeneficiaryView,
  LimitView,
  PurposeCode,
} from '@/api/payments/schemas';
import { AmountField, PayeeLine } from '@/features/payments/components';
import {
  amountToMinor,
  compareMinor,
  currencySymbol,
  emptyAmount,
  formatMinor,
  isAmountEmpty,
  minorExceeds,
  type AmountEntry,
} from '@/features/payments/money';
import {
  CORRIDOR_META,
  PURPOSE_LABEL,
  purposesFor,
  typeForPurpose,
} from '@/features/payments/meta';
import { useQuote } from '@/features/payments/use-quote';

/**
 * Step 2: HOW MUCH.
 *
 * The screen the cheque-book direction exists for. Three things happen here that no other
 * payments app does, and each is the same device from paper finance:
 *
 * 1. **The amount appears in words from the FIRST keystroke**, not on the confirmation screen.
 *    The user watches "Two lakh fifty thousand rupees" assemble as they type, so a mistyped zero
 *    is caught while their thumb is still on the keypad rather than three screens later.
 * 2. **The remaining daily limit is on screen before they type**, and the error names the
 *    number. A cap discovered at submit time reads as a bug; a cap stated up front is a rule.
 * 3. **Purpose is a real declaration**, not a dropdown nobody reads. On the cross-border corridor
 *    it is an RBI/FEMA code the payment legally cannot travel without, so it is presented as
 *    chips with plain-English labels and no default — an unmade choice is better than a wrong
 *    filing.
 *
 * The amount is a native `TextInput` with a number pad rather than a bespoke on-screen keypad.
 * A custom keypad would fit the instrument grammar better, but it loses hardware keyboards,
 * external switch access and the OS's own accessibility affordances — and on the one screen where
 * a wrong digit costs money, the platform's input is worth more than the styling.
 */
export function SendAmountScreen() {
  const { beneficiaryId } = useLocalSearchParams<{ beneficiaryId: string }>();
  const router = useRouter();
  const p = usePalette();

  const [payee, setPayee] = useState<BeneficiaryView | null>(null);
  const [limits, setLimits] = useState<LimitView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [entry, setEntry] = useState<AmountEntry>(emptyAmount);
  const [purpose, setPurpose] = useState<PurposeCode | null>(null);
  const [narration, setNarration] = useState('');

  const quote = useQuote();

  // The corridor is derived from the PAYEE, never chosen. A PAYNOW_UPI payee is reachable only
  // over the cross-border linkage, and letting a user pick would let them ask for the domestic
  // ₹1,00,000 cap on a transfer the SGD 1,000 rule governs.
  const corridor = payee?.handleType === 'PAYNOW_UPI' ? 'CROSS_BORDER' : 'DOMESTIC';
  const sourceCurrency = corridor === 'CROSS_BORDER' ? 'SGD' : 'INR';
  const destCurrency = payee?.currency ?? 'INR';

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [bene, wallet] = await Promise.all([
          beneficiaryService.detail(beneficiaryId),
          paymentsService.wallet(),
        ]);
        if (!alive) return;
        setPayee(bene);
        setLimits(
          bene.handleType === 'PAYNOW_UPI'
            ? wallet.limits.crossBorder
            : wallet.limits.domestic,
        );
        setLoadError(null);
      } catch (caught) {
        if (!alive) return;
        setLoadError(
          caught instanceof Error ? caught.message : 'Could not load this payee.',
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [beneficiaryId]);

  const minor = amountToMinor(entry);
  const empty = isAmountEmpty(entry);

  /**
   * Every reason this amount cannot be sent, checked in the order the user would hit them.
   *
   * Client-side and advisory — the server enforces all of it — but the point is to say the number
   * BEFORE the user commits. Each message names the cap and what is left, because "limit
   * exceeded" without a figure is not something anybody can act on.
   */
  const problem = ((): string | null => {
    if (empty || !limits) return null;

    if (minorExceeds(minor, limits.perTransaction.minor)) {
      return `A single payment on this rail cannot be more than ${limits.perTransaction.formatted}.`;
    }
    if (minorExceeds(minor, limits.dailyRemaining.minor)) {
      return `You have ${limits.dailyRemaining.formatted} left to send today on this rail. It resets at midnight.`;
    }
    if (
      limits.dailyCountCap > 0 &&
      limits.dailyUsedCount >= limits.dailyCountCap
    ) {
      return `You have used all ${limits.dailyCountCap} payments allowed today on this rail.`;
    }
    // The cooling period is a per-PAYEE cap, so it is checked against this payee's own ceiling
    // rather than the corridor's.
    if (
      payee?.coolingPeriod &&
      minorExceeds(minor, payee.coolingPeriod.capMinor)
    ) {
      return `You added this payee less than 24 hours ago, so payments to them are capped at ${formatMinor(
        payee.coolingPeriod.capMinor,
        sourceCurrency,
      )} ${sourceCurrency} for now. This protects you if somebody pressured you into adding them.`;
    }
    return null;
  })();

  const canPrice = !empty && problem === null && purpose !== null && !quote.loading;

  const onPrice = async () => {
    if (!purpose || !payee) return;
    const priced = await quote.request({
      sourceCurrency,
      destCurrency,
      mode: 'SOURCE',
      amountMinor: minor,
      type: typeForPurpose(purpose, corridor),
      purposeCode: purpose,
    });
    if (!priced) return;

    router.push({
      pathname: '/(app)/payments/send/confirm',
      params: {
        beneficiaryId: payee.id,
        quoteId: priced.quoteId,
        // The purpose and note travel with the instruction rather than being re-picked: the user
        // has already written them, and asking again would be a tap that carries no information.
        purposeCode: purpose,
        narration,
        /**
         * The priced figures, for DISPLAY on the confirmation screen.
         *
         * Safe to carry as a param because they cannot change what is charged: the server prices
         * from the stored `quoteId` and cross-checks `expectedTotalDebitMinor` against it, so a
         * stale or tampered value can only produce a 409. Re-pricing on the next screen would be
         * actively wrong — a second quote is a second lock at a second rate.
         */
        q: JSON.stringify(priced),
      },
    } as never);
  };

  if (loading) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Amount' }} />
        <View style={styles.centre}>
          <Spinner label="Loading this payee" />
        </View>
      </Screen>
    );
  }

  if (loadError || !payee) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Amount' }} />
        <Notice tone="error" title="Could not open this payee">
          {loadError ?? 'That payee could not be found.'}
        </Notice>
      </Screen>
    );
  }

  const purposes = purposesFor(corridor);

  return (
    <Screen
      scroll
      footer={
        <Button
          label={quote.loading ? 'Pricing…' : 'Price this payment'}
          onPress={onPrice}
          disabled={!canPrice}
          loading={quote.loading}
          hint={
            purpose === null && !empty
              ? 'Choose what this payment is for'
              : undefined
          }
        />
      }
    >
      <Stack.Screen options={{ title: 'Amount' }} />

      <Header legend="Step 2 of 3" title="How much?" />

      {/* Who, restated. The user must not have to remember who they picked. */}
      <Panel pad="md" notch>
        <PayeeLine
          registeredName={payee.registeredName}
          handle={payee.handle}
          unreachableReason={
            payee.status !== 'VERIFIED' ? payee.statusReason : null
          }
        />
      </Panel>

      {/* THE AMOUNT — figures, then words, live. */}
      {/*
        The cheque's own check, live. Not on the confirmation screen — here, while the thumb is
        still on the keypad, because that is when a mistyped zero is cheap to fix.
      */}
      <AmountField
        entry={entry}
        onChange={setEntry}
        currency={sourceCurrency}
        label={corridor === 'CROSS_BORDER' ? 'You send' : 'Amount'}
        autoFocus
      />

      {/* The cap, stated before it is hit. */}
      {limits ? (
        <View style={styles.limitRow}>
          <Micro>
            {limits.dailyRemaining.formatted} left to send today
            {limits.dailyCountCap > 0
              ? ` · ${limits.dailyCountCap - limits.dailyUsedCount} payments left`
              : ''}
          </Micro>
          {!empty && problem === null ? (
            <Micro style={{ color: p.cleared }}>
              {remainingAfter(limits, minor, sourceCurrency)}
            </Micro>
          ) : null}
        </View>
      ) : null}

      {problem ? (
        <Notice tone="caution" title="Over the limit">
          {problem}
        </Notice>
      ) : null}

      {/* Purpose. No default: an unmade choice beats a wrong filing. */}
      <View style={styles.purposeBlock}>
        <Legend small>
          {corridor === 'CROSS_BORDER' ? 'Purpose (required by RBI)' : 'What is this for?'}
        </Legend>
        <ChipRow>
          {purposes.map((code) => (
            <Chip
              key={code}
              label={PURPOSE_LABEL[code]}
              selected={purpose === code}
              onPress={() => setPurpose(code)}
            />
          ))}
        </ChipRow>
        {corridor === 'CROSS_BORDER' ? (
          <Micro>
            An international transfer must declare its purpose. This is filed with the
            payment and cannot be changed afterwards.
          </Micro>
        ) : null}
      </View>

      <TextField
        label="Note for them (optional)"
        value={narration}
        onChangeText={setNarration}
        placeholder="Rent, June"
        maxLength={50}
        hint="Up to 50 characters. Shown to the person you are paying."
      />

      {quote.error ? (
        <Notice tone="error" title="Could not price that">
          {quote.error}
        </Notice>
      ) : null}

      <Micro>
        {CORRIDOR_META[corridor].detail} You will see the exact fee and the amount they
        receive before anything is sent.
      </Micro>
    </Screen>
  );
}

/** "₹95,500.00 left after this" — the consequence, stated at the moment of choosing. */
function remainingAfter(
  limits: LimitView,
  minor: string,
  currency: string,
): string {
  if (compareMinor(limits.dailyRemaining.minor, minor) < 0) return '';
  const left = (
    BigInt(limits.dailyRemaining.minor) - BigInt(minor)
  ).toString();
  return `${currencySymbol(currency)}${formatMinor(left, currency)} left after this`;
}

const styles = StyleSheet.create({
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  limitRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.md,
    flexWrap: 'wrap',
  },
  purposeBlock: { gap: Space.sm },
});
