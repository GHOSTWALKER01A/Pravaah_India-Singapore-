import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

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
  Text,
  TextField,
  haptic,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import { transferService } from '@/api/payments/services';
import type { DisputeKind } from '@/api/payments/schemas';
import { ROUTES } from '@/constants/routes.constants';
import { DISPUTE_KIND } from '@/features/payments/meta';

/** The order a customer would recognise: the common complaint first, the fraud claim last. */
const KINDS: readonly DisputeKind[] = [
  'NOT_CREDITED',
  'DUPLICATE_DEBIT',
  'AMOUNT_MISMATCH',
  'WRONG_BENEFICIARY',
  'CHARGEBACK',
  'UNAUTHORISED',
];

/**
 * Raise a UDIR dispute.
 *
 * The categories are the ones a person would actually say out loud — "they never received it",
 * "I was charged twice" — rather than the internal failure codes. That is the whole point of UDIR:
 * it exists so a customer with a debited account and an uncredited payee has somewhere to go other
 * than a branch queue, and a form that asked them to classify their own problem in our vocabulary
 * would defeat it.
 *
 * The screen is explicit that raising a dispute is a CLAIM, not a refund. Money moves only if the
 * dispute is upheld, and saying that up front is better than an expectation set by a button labelled
 * "get my money back".
 */
export function NewDisputeScreen() {
  const { transactionId } = useLocalSearchParams<{ transactionId: string }>();
  const router = useRouter();
  const p = usePalette();

  const [kind, setKind] = useState<DisputeKind | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = kind ? DISPUTE_KIND[kind] : null;
  // The server requires at least ten characters, so the gate matches rather than surprising them.
  const canSubmit = kind !== null && description.trim().length >= 10 && !busy;

  const onSubmit = async () => {
    if (!kind) return;
    setBusy(true);
    setError(null);
    try {
      await transferService.raiseDispute(transactionId, {
        kind,
        description: description.trim(),
      });
      haptic.commit();
      router.replace(ROUTES.PAY.DISPUTES);
    } catch (caught) {
      haptic.refused();
      setError(
        caught instanceof Error ? caught.message : 'Could not raise that dispute.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      scroll
      footer={
        <Button
          label={busy ? 'Sending…' : 'Raise the dispute'}
          onPress={onSubmit}
          disabled={!canSubmit}
          loading={busy}
          hint={
            kind === null
              ? 'Choose what went wrong'
              : description.trim().length < 10
                ? 'Tell us what happened, in a sentence or two'
                : undefined
          }
        />
      }
    >
      <Stack.Screen options={{ title: 'Report a problem' }} />

      <Header
        title="What went wrong?"
        lede="Pick the closest one. We will investigate and come back to you with a deadline you can hold us to."
      />

      <View style={styles.block}>
        <Legend small>The problem</Legend>
        <Panel pad="none" notch>
          {KINDS.map((code, index) => (
            <View key={code}>
              {index > 0 ? <Rule /> : null}
              <Press
                onPress={() => setKind(code)}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === code }}
                accessibilityLabel={DISPUTE_KIND[code].label}
                accessibilityHint={DISPUTE_KIND[code].detail}
              >
                <View
                  style={[styles.row, kind === code && { backgroundColor: p.fieldWash }]}
                >
                  <View style={styles.rowText}>
                    <Text role="bodyMedium">{DISPUTE_KIND[code].label}</Text>
                    <Micro>{DISPUTE_KIND[code].detail}</Micro>
                  </View>
                  {kind === code ? (
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

      {/*
        The fraud claim gets its own warning, because it is a materially different report: it may
        lead to the account being restricted while it is investigated, and somebody choosing it
        because it sounds closest to "something is wrong" should know that.
      */}
      {kind === 'UNAUTHORISED' ? (
        <Notice tone="caution" title="This is a fraud report">
          Only choose this if you did not make the payment at all. We may restrict your account
          while we investigate, to stop anything else going out. If you made the payment but
          something else went wrong, one of the other options fits better.
        </Notice>
      ) : null}

      <TextField
        label="What happened?"
        value={description}
        onChangeText={setDescription}
        placeholder={
          meta
            ? meta.label === 'They never received it'
              ? 'I paid my landlord on the 14th and he says nothing arrived in his account.'
              : 'Describe what you saw, and when.'
            : 'Describe what happened.'
        }
        multiline
        numberOfLines={4}
        maxLength={1000}
        hint="A date, an amount and what the other person told you all help. Minimum ten characters."
      />

      {error ? (
        <Notice tone="error" title="Could not raise that">
          {error}
        </Notice>
      ) : null}

      <View style={[styles.terms, { borderColor: p.rule }]}>
        <Micro>
          Raising a dispute is a claim, not a refund — money moves only if we uphold it. We are
          obliged to answer inside a fixed window, and the deadline appears on the dispute as soon
          as it is raised so you can see it rather than take our word for it. You can withdraw a
          dispute at any time.
        </Micro>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  terms: {
    borderTopWidth: Hairline.base,
    paddingTop: Space.md,
  },
});
