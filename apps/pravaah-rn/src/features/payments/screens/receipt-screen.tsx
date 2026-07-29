import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  FieldGrid,
  FieldRow,
  Legend,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  Seal,
  Spinner,
  StatusMark,
  Text,
  haptic,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { ROUTES } from '@/constants/routes.constants';
import { AmountLine, PayeeLine, Perforation, ReturnMemo } from '@/features/payments/components';
import { formatMinor } from '@/features/payments/money';
import { LEDGER_LEG_LABEL, PURPOSE_LABEL, txnStatus } from '@/features/payments/meta';
import { useReceipt, useTransfer } from '@/features/payments/use-transfer';
import { StepUpPrompt } from '@/features/security/components';

import { transferService } from '@/api/payments/services';
import type { PurposeCode } from '@/api/payments/schemas';

/**
 * The counterfoil — the stub that stays in the book, and the live status screen.
 *
 * One screen, not two, and that is the direction earning its keep. Every payments app has a
 * "processing…" spinner screen and a separate receipt, which means the moment of highest anxiety
 * is spent on a screen that shows the LEAST information. A counterfoil is the same object
 * throughout: it exists from the instant the cheque is torn out, and what changes is only the
 * stamp on it. So the amount, the payee and the reference are readable while the payment is still
 * clearing, and nothing is withheld pending an outcome.
 *
 * The polling is `useTransfer`'s, with a backoff. When the payment reaches a final state the
 * screen fetches the full receipt — the user's own ledger movements — because those are what make
 * this a document rather than a status: the fee as its own line, the reserve, the refund.
 */
export function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const p = usePalette();

  const { transaction, loading, error, settled, refresh } = useTransfer(id);
  const { receipt } = useReceipt(settled ? id : null);

  /**
   * The M6 challenge, read off the polled transaction rather than held in state.
   *
   * Derived, deliberately. The poll is the source of truth for whether a challenge is still
   * live — it expires, it can be consumed on another device, and an analyst can resolve the
   * hold out from under it. A copy in local state would keep rendering a prompt for a
   * challenge that no longer exists, and the user would type a code into a dead field.
   */
  const stepUp = transaction?.stepUp ?? null;

  const [confirming, setConfirming] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  /**
   * Answer the challenge, then let the poll take over.
   *
   * The response IS the updated payment, but it is deliberately not written into state here —
   * `refresh()` re-reads through the same path every other update arrives on. Setting it
   * directly would create a second way for this screen's transaction to change, and the two
   * would disagree the moment a poll landed between the confirm and the set.
   */
  const confirmStepUp = async (answer: string) => {
    if (!stepUp || confirming) return;
    setConfirming(true);
    setStepUpError(null);
    try {
      await transferService.confirmStepUp(id, stepUp.nonce, answer);
      haptic.commit();
      await refresh();
    } catch (caught) {
      setStepUpError(
        caught instanceof Error
          ? caught.message
          : 'That code was not correct. Try again.',
      );
      /**
       * Refreshed even on failure, so `attemptsRemaining` is current.
       *
       * Without this the prompt would keep showing the count from before the wrong guess, and
       * a user on their last attempt would be told they had two.
       */
      await refresh();
    } finally {
      setConfirming(false);
    }
  };

  /**
   * Ask for a fresh challenge when the last one lapsed.
   *
   * Wired to the prompt's own action so the user is never looking at a dead field. The reason it
   * is needed at all: a challenge lives five minutes and the poll reports only live ones, so
   * coming back to the app after a delay showed a payment "under review" with no route out — and
   * a PIN prompt deliberately shows no countdown, which makes lapsing the common case rather than
   * the rare one.
   *
   * Errors surface through the SAME `stepUpError` the confirm path uses, deliberately. The server
   * refuses this when the payment is under analyst review rather than awaiting the user, and that
   * refusal carries the only message that is true — a second error slot would mean two places for
   * the same panel to report a failure from.
   */
  const requestStepUp = async () => {
    if (confirming) return;
    setConfirming(true);
    setStepUpError(null);
    try {
      await transferService.requestStepUp(id);
      await refresh();
    } catch (caught) {
      setStepUpError(
        caught instanceof Error
          ? caught.message
          : 'We could not start a new confirmation. Please try again.',
      );
      await refresh();
    } finally {
      setConfirming(false);
    }
  };

  // One haptic when the outcome lands, not on every poll. The ref is what stops a re-render from
  // firing it again — a phone buzzing four times as a screen settles is worse than silence.
  const announced = useRef(false);
  useEffect(() => {
    if (!transaction || !settled || announced.current) return;
    announced.current = true;
    if (transaction.status === 'SUCCESS') haptic.cleared();
    else if (txnStatus(transaction.status).tone === 'carmine') haptic.refused();
  }, [transaction, settled]);

  if (loading && !transaction) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Payment' }} />
        <View style={styles.centre}>
          <Spinner label="Loading this payment" />
        </View>
      </Screen>
    );
  }

  if (!transaction) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Payment' }} />
        <Notice tone="error" title="Could not find this payment">
          {error ?? 'That payment does not exist, or is not yours.'}
        </Notice>
      </Screen>
    );
  }

  const meta = txnStatus(transaction.status);
  const inbound = transaction.direction === 'INBOUND';
  const crossBorder = transaction.corridor === 'CROSS_BORDER';
  const isHold = transaction.status === 'DEEMED' || transaction.status === 'RISK_HELD';
  const failed = meta.tone === 'carmine';

  return (
    <Screen
      scroll
      footer={
        settled ? (
          <Button
            label="Done"
            onPress={() => router.replace(ROUTES.TABS.PAY as never)}
          />
        ) : undefined
      }
    >
      <Stack.Screen options={{ title: 'Counterfoil' }} />

      {/* ── THE STUB ────────────────────────────────────────────────────── */}
      <View style={[styles.stub, { borderColor: p.ruleStrong, backgroundColor: p.panel }]}>
        <Perforation edge="top" />

        <View style={styles.stubBody}>
          <View style={styles.head}>
            <Legend small>{inbound ? 'Received · counterfoil' : 'Paid · counterfoil'}</Legend>
            {/*
              The seal IS the status. A cleared payment gets a filled seal, an in-flight one an
              open seal that animates only while genuinely in flight, a failure a struck seal.
              Never colour alone — every state has its own shape.
            */}
            <StatusMark status={transaction.status} labelled />
          </View>

          <Rule />

          <PayeeLine
            registeredName={transaction.counterpartyName}
            handle={transaction.counterparty}
          />

          <Rule />

          <AmountLine
            minor={inbound ? transaction.theyGet.minor : transaction.totalDebit.minor}
            currency={
              inbound ? transaction.theyGet.currency : transaction.totalDebit.currency
            }
            formatted={
              inbound ? transaction.theyGet.formatted : transaction.totalDebit.formatted
            }
            label={inbound ? 'Amount received' : 'Total paid'}
          />

          {/*
            The seal, impressed on the stub once it clears. Present only on a settled payment,
            because a seal on an unsettled instruction would be claiming an outcome.
          */}
          {transaction.status === 'SUCCESS' ? (
            <View style={styles.seal}>
              {/* `voidColor` is the surface the seal sits on, so the mark reads as a hole
                  punched in the disc rather than a shape drawn on it. */}
              <Seal shape="filled" size={44} color={p.cleared} voidColor={p.panel} />
              <View style={styles.sealText}>
                <Text role="bodySmMedium" style={{ color: p.cleared }}>
                  Cleared
                </Text>
                <Micro>{completedAt(transaction.completedAt)}</Micro>
              </View>
            </View>
          ) : null}
        </View>
      </View>

      {/* ── THE M6 STEP-UP ──────────────────────────────────────────────── */}
      {/*
        A challenge waiting on the USER, rendered above the clearing state.

        This is the branch that distinguishes the two things `RISK_HELD` means. A payment with
        a live challenge is waiting on the person holding the phone and can be released in two
        taps; one WITHOUT a challenge is waiting on an analyst and cannot. Rendering the same
        "under review" copy for both would tell a user to wait for a human when they could
        have finished the payment themselves.

        Placed above the clearing panel because it is the only actionable thing on the screen,
        and below the stub because the amount and payee are what the user checks BEFORE
        confirming — a challenge above the figures would ask them to authorise something they
        have to scroll to read.
      */}
      {stepUp ? (
        <View style={styles.stepUp}>
          <StepUpPrompt
            challenge={stepUp}
            onSubmit={(answer) => void confirmStepUp(answer)}
            onResend={() => void requestStepUp()}
            busy={confirming}
            error={stepUpError}
            reason="This payment needs one more confirmation before it goes out."
          />
        </View>
      ) : null}

      {/* ── WHILE IT CLEARS ─────────────────────────────────────────────── */}
      {!settled ? (
        <View style={[styles.clearing, { borderColor: p.latent }]}>
          <View style={styles.clearingHead}>
            <Spinner />
            <Text role="bodyMedium" style={{ color: p.latent }}>
              {meta.label}
            </Text>
          </View>
          <Micro>{meta.detail}</Micro>
          {/*
            Said plainly while they wait, because it is the question they are actually asking.
            "Processing" answers nothing; "the money has left your wallet and is held, and cannot
            be paid twice" answers it.
          */}
          <Micro>
            {meta.debited
              ? 'The amount has left your wallet and is being held until the network confirms. It can never be paid twice — this instruction has one reference for its whole life.'
              : 'Nothing has left your wallet yet.'}
          </Micro>
        </View>
      ) : null}

      {/* ── A RETURN, OR A HOLD ─────────────────────────────────────────── */}
      {failed || isHold ? (
        <ReturnMemo
          status={transaction.status}
          railMessage={transaction.railMessage}
          failureReason={transaction.failureReason}
          onRetry={
            transaction.canRetry
              ? () => router.push(ROUTES.PAY.SEND)
              : undefined
          }
          onDispute={
            // A dispute only makes sense once something actually happened. Offering it on a
            // clean reversal, where nothing left the wallet, would invite a complaint about a
            // payment that did not occur.
            meta.debited && !isHold
              ? () => router.push(ROUTES.PAY.DISPUTE_NEW(transaction.id))
              : undefined
          }
        />
      ) : null}

      {/* ── THE PARTICULARS ─────────────────────────────────────────────── */}
      <Panel pad="none" notch>
        <FieldGrid>
          <FieldRow
            label="For"
            value={PURPOSE_LABEL[transaction.purposeCode as PurposeCode] ?? transaction.purposeCode}
          />
          {transaction.narration ? (
            <FieldRow label="Note" value={transaction.narration} prose />
          ) : null}
          <FieldRow label="Written" value={fullDate(transaction.createdAt)} />
          {/*
            The UTR is the one thing on this screen with power OUTSIDE the app: it is the
            reference a bank recognises when a customer rings up. Given its own row, in the
            measured face, long-pressable — never buried.
          */}
          {transaction.utr ? (
            <FieldRow label="Bank reference (UTR)" value={transaction.utr} />
          ) : null}
          <FieldRow
            label="Rail"
            value={crossBorder ? 'UPI–PayNow' : 'UPI'}
          />
        </FieldGrid>
      </Panel>

      {/* The cross-border breakdown, kept on the receipt so a remittance can be reconciled. */}
      {crossBorder ? (
        <Panel pad="none" notch>
          <FieldGrid>
            <FieldRow label="You sent" value={transaction.youSend.formatted} />
            <FieldRow label="Fee" value={transaction.fee.formatted} />
            {transaction.tax.minor !== '0' ? (
              <FieldRow label="Tax" value={transaction.tax.formatted} />
            ) : null}
            <FieldRow label="They received" value={transaction.theyGet.formatted} />
          </FieldGrid>
        </Panel>
      ) : null}

      {/* ── THE LEDGER, AS THE STUB'S LINE ITEMS ────────────────────────── */}
      {receipt && receipt.movements.length > 0 ? (
        <View style={styles.ledgerBlock}>
          <Legend small>What moved in your wallet</Legend>
          <Panel pad="none" notch>
            <FieldGrid>
              {receipt.movements.map((movement, index) => (
                <FieldRow
                  key={`${movement.leg}-${index}`}
                  label={LEDGER_LEG_LABEL[movement.leg] ?? movement.leg}
                  value={`${movement.direction === 'CREDIT' ? '+' : '−'}${formatMinor(
                    movement.amountMinor,
                    movement.currency,
                  )}`}
                />
              ))}
            </FieldGrid>
          </Panel>
          <Micro>
            Every line is a real entry in a double-entry ledger. This is why a failed payment
            comes back to you in full, and why one the network confirms late is never paid twice.
          </Micro>
        </View>
      ) : null}

      {/* Refunds, when there are any. Shown as their own facts, not netted into the amount. */}
      {receipt && receipt.refunds.length > 0 ? (
        <View style={styles.ledgerBlock}>
          <Legend small>Refunds</Legend>
          <Panel pad="none" notch>
            <FieldGrid>
              {receipt.refunds.map((refund) => (
                <FieldRow
                  key={refund.id}
                  label={refund.reason}
                  value={`${formatMinor(
                    refund.amountMinor,
                    transaction.totalDebit.currency,
                  )} · ${refund.status.toLowerCase()}`}
                />
              ))}
            </FieldGrid>
          </Panel>
        </View>
      ) : null}

      {settled && meta.debited && !failed ? (
        <Button
          label="Something wrong with this payment?"
          variant="quiet"
          onPress={() => router.push(ROUTES.PAY.DISPUTE_NEW(transaction.id))}
        />
      ) : null}
    </Screen>
  );
}

function fullDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function completedAt(iso: string | null): string {
  if (!iso) return '';
  return fullDate(iso);
}

const styles = StyleSheet.create({
  stepUp: { marginTop: Space.xxl },
  centre: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  stub: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  stubBody: { padding: Space.lg, gap: Space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  seal: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  sealText: { gap: 1 },
  clearing: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    gap: Space.sm,
  },
  clearingHead: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  ledgerBlock: { gap: Space.sm },
});
