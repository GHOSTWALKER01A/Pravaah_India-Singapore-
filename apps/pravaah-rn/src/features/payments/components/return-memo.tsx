import { StyleSheet, View } from 'react-native';

import { Button, Icon, Legend, Micro, Rule, Text } from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import type { TxnStatus } from '@/api/payments/schemas';

import { txnStatus } from '../meta';

/**
 * The return memo — a bank's slip explaining why an instruction was not honoured.
 *
 * When a cheque is dishonoured the bank does not hand back a blank; it returns the cheque with a
 * printed memo naming the reason. That artifact is exactly the right shape for a failed payment,
 * and it fixes the two things payment error states usually get wrong:
 *
 * 1. **It names the reason in the bank's own words, and separately names what to do.** "Your bank
 *    declined this — check your balance and try again" is the memo; "Not paid" is only the stamp.
 *    The backend already translates every NPCI code into an actionable sentence, so the memo has
 *    real content rather than a code.
 * 2. **It distinguishes "not honoured" from "not answered".** A DEEMED payment is NOT a return —
 *    nothing has been dishonoured, the rail simply has not replied. So this component renders a
 *    genuinely different object in that case: a **hold notice**, in gold rather than carmine,
 *    which says the money is safe and is being confirmed. Styling that as a failure would tell a
 *    user their money is gone when it is not, and invite them to pay again.
 *
 * Carmine appears here and it is earned: failure is one of the four things DESIGN.md reserves the
 * second colour for.
 */
interface ReturnMemoProps {
  status: TxnStatus;
  /** The rail's own reason, already translated by the backend. Preferred over the fallback. */
  railMessage?: string | null;
  failureReason?: string | null;
  /** Offered only when the rail said a retry could work. */
  onRetry?: () => void;
  onDispute?: () => void;
}

export function ReturnMemo({
  status,
  railMessage,
  failureReason,
  onRetry,
  onDispute,
}: ReturnMemoProps) {
  const p = usePalette();
  const meta = txnStatus(status);

  // A hold is not a return. Different object, different colour, different words.
  const isHold = status === 'DEEMED' || status === 'RISK_HELD';
  const ink = isHold ? p.latent : p.carmine;
  const wash = isHold ? p.latentWash : p.carmineWash;

  const reason = railMessage ?? failureReason ?? meta.detail;

  return (
    <View
      style={[styles.memo, { borderColor: ink, backgroundColor: wash }]}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${meta.label}. ${reason}`}
    >
      <View style={styles.head}>
        <Icon name={isHold ? 'clock' : 'cross'} size={16} color={ink} />
        <View style={styles.headText}>
          <Legend small>{isHold ? 'Hold notice' : 'Return memo'}</Legend>
          <Text role="bodyMedium" style={{ color: ink }}>
            {meta.label}
          </Text>
        </View>
      </View>

      <Rule />

      <Text role="bodySm">{reason}</Text>

      {/*
        The money's whereabouts, stated explicitly and separately from the reason.
        This is the sentence a person actually wants and almost never gets: not "what went
        wrong" but "where is my money right now".
      */}
      <Micro>
        {isHold
          ? 'Your money is held safely and has not been paid out. We are confirming with the network and will not let it be paid twice.'
          : meta.debited
            ? 'The amount is being returned to your wallet.'
            : 'Nothing left your wallet.'}
      </Micro>

      {onRetry || onDispute ? (
        <View style={styles.actions}>
          {onRetry ? (
            <Button label="Try again" onPress={onRetry} variant="secondary" inline />
          ) : null}
          {onDispute ? (
            <Button
              label="Raise a dispute"
              onPress={onDispute}
              variant="quiet"
              inline
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  memo: {
    borderWidth: Hairline.base,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    gap: Space.sm,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  headText: { flexGrow: 1, flexShrink: 1, gap: 1 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
    marginTop: Space.xs,
  },
});
