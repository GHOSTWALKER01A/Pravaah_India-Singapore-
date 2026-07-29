import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Chip,
  ChipRow,
  Header,
  Legend,
  Micro,
  Notice,
  Screen,
  TextField,
  haptic,
} from '@/components/ui';
import { Space } from '@/theme';

import { collectService } from '@/api/payments/services';
import type { PurposeCode } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { AmountField } from '@/features/payments/components';
import {
  amountToMinor,
  emptyAmount,
  isAmountEmpty,
  type AmountEntry,
} from '@/features/payments/money';
import { DOMESTIC_PURPOSES, PURPOSE_LABEL } from '@/features/payments/meta';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

const VPA_SHAPE = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$/;

/**
 * Request money — a UPI collect.
 *
 * The mirror of a payment, and the screen makes the asymmetry explicit rather than presenting it as
 * "sending in reverse". Three things are stated plainly because users get them wrong:
 *
 * - **They have to approve it in their own app.** We cannot pull money on somebody's word.
 * - **It expires.** A live request is an open authorisation sitting in a stranger's app, and one
 *   that could be approved days later would debit against an intent that has moved on.
 * - **Approval is not receipt.** Their bank can still decline for insufficient funds after they
 *   have said yes, which is why the request list shows "approved" and "received" as different states.
 *
 * Domestic only, and the copy says why: the UPI–PayNow link is payer-initiated, so there is no such
 * thing as requesting money from abroad. Hiding that behind a generic error would have people trying
 * repeatedly.
 */
export function RequestMoneyScreen() {
  const router = useRouter();

  const [payer, setPayer] = useState('');
  const [entry, setEntry] = useState<AmountEntry>(emptyAmount);
  const [purpose, setPurpose] = useState<PurposeCode>('P2P_TRANSFER');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { key: idempotencyKey } = useIdempotencyKey();

  const normalised = payer.trim().toLowerCase();
  const payerValid = VPA_SHAPE.test(normalised);
  const minor = amountToMinor(entry);
  const canSend = payerValid && !isAmountEmpty(entry) && !sending;

  const onSend = async () => {
    setSending(true);
    setError(null);
    try {
      const created = await collectService.create(idempotencyKey, {
        payerHandle: normalised,
        amountMinor: minor,
        currency: 'INR',
        purposeCode: purpose,
        narration: note || undefined,
        expiresInSeconds: 300,
      });
      haptic.commit();
      router.replace(ROUTES.PAY.REQUESTS);
      void created;
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof Error ? caught.message : 'That request could not be sent.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen
      scroll
      footer={
        <Button
          label={sending ? 'Sending…' : 'Send the request'}
          onPress={onSend}
          disabled={!canSend}
          loading={sending}
        />
      }
    >
      <Stack.Screen options={{ title: 'Request money' }} />

      <Header
        title="Request money"
        lede="They approve it in their own UPI app. Nothing moves until they do."
      />

      <TextField
        label="Their UPI ID"
        value={payer}
        onChangeText={setPayer}
        placeholder="name@bank"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        measured
        error={
          payer.length > 3 && !payerValid
            ? 'A UPI ID looks like name@bank.'
            : null
        }
      />

      {/*
        The same figures-and-words check as a payment: a request for the wrong amount is a debt
        somebody else pays.
      */}
      <AmountField
        entry={entry}
        onChange={setEntry}
        currency="INR"
        label="Amount to request"
      />

      <View style={styles.purposeBlock}>
        <Legend small>What is this for?</Legend>
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

      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        placeholder="Dinner split"
        maxLength={50}
        hint="They see this in their UPI app."
      />

      {error ? (
        <Notice tone="error" title="Not sent">
          {error}
        </Notice>
      ) : null}

      <Micro>
        The request expires in five minutes. That is deliberate — an open request sitting in
        somebody&apos;s app could otherwise be approved days later, against money and an
        intention that have both moved on. Their bank can also decline after they approve, so
        you will see &ldquo;approved&rdquo; and &ldquo;received&rdquo; as two different steps.
        Requesting money only works within India: the UPI–PayNow link is payer-initiated, so
        money can be sent from Singapore but not pulled to it.
      </Micro>
    </Screen>
  );
}

const styles = StyleSheet.create({
  amountBlock: { gap: Space.sm },
  purposeBlock: { gap: Space.sm },
});
