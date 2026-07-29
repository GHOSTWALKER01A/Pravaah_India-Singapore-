import { StyleSheet, View } from 'react-native';

import {
  Icon,
  Micro,
  Press,
  StatusMark,
  Text,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import type { TransactionView } from '@/api/payments/schemas';

import { txnStatus } from '../meta';
import { Perforation } from './perforation';

/**
 * A counterfoil — the stub a torn-out cheque leaves in the book.
 *
 * The default row for any list of payments, and it replaces the card. Its left edge is
 * perforated, which is the entire semantic: **this is what stayed behind after the instruction
 * went out.** A list of these reads as a book you have been spending from, in the order you spent
 * — which is what a payment history actually is, and is not what a feed of rounded rectangles
 * with avatars communicates.
 *
 * Three decisions inside it:
 *
 * - **The amount is signed by DIRECTION, not by colour.** An outbound payment carries a real
 *   minus. Carmine is reserved for the word under pressure — revocation, failure — so spending
 *   money is not styled as a bad outcome, because it is not one.
 * - **In-flight payments say what is true, not "processing".** The status detail comes from the
 *   table in `features/payments/meta`, so a DEEMED payment reads "still confirming, your money is safe"
 *   rather than being lumped in with failures.
 * - **A settled payment shows its UTR.** It is the reference the user quotes to their bank, and
 *   the only identifier both PSPs recognise. Hiding it behind a detail screen is hiding the one
 *   piece of a receipt that has power outside the app.
 */
interface CounterfoilProps {
  transaction: TransactionView;
  onPress?: () => void;
  /** The last stub in a run gets no bottom rule. */
  last?: boolean;
}

export function Counterfoil({ transaction, onPress, last = false }: CounterfoilProps) {
  const p = usePalette();
  const meta = txnStatus(transaction.status);

  const inbound = transaction.direction === 'INBOUND';
  // The figure the user cares about: what left their wallet including the fee, or what arrived.
  const figure = inbound
    ? transaction.theyGet.formatted
    : transaction.totalDebit.formatted;

  const tone = meta.tone;
  const amountColour =
    tone === 'carmine' ? p.carmine : inbound ? p.cleared : p.ink;

  const body = (
    <View style={[styles.stub, !last && { borderBottomColor: p.rule }, !last && styles.ruled]}>
      {/* The tear edge, down the left. This is what makes it a stub. */}
      <Perforation edge="left" />

      <View style={styles.content}>
        <View style={styles.top}>
          <View style={styles.who}>
            <Text role="bodyMedium" numberOfLines={1}>
              {transaction.counterpartyName ?? transaction.counterparty}
            </Text>
            <Micro numberOfLines={1}>
              {stubDate(transaction.createdAt)} · {transaction.counterparty}
            </Micro>
          </View>

          <View style={styles.figure}>
            <Text
              role="valueSm"
              style={{ color: amountColour, fontSize: 24, lineHeight: 28, letterSpacing: -0.4 }}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {inbound ? '+' : '−'}
              {figure}
            </Text>
            {transaction.corridor === 'CROSS_BORDER' ? (
              <Micro numberOfLines={1}>
                {inbound ? '' : `they get ${transaction.theyGet.formatted}`}
              </Micro>
            ) : null}
          </View>
        </View>

        <View style={styles.bottom}>
          <StatusMark status={transaction.status} labelled size={11} />

          {/* Only when the status needs explaining. A settled payment's detail is noise. */}
          {meta.tone !== 'field' ? (
            <Micro style={styles.detail} numberOfLines={2}>
              {transaction.railMessage ?? meta.detail}
            </Micro>
          ) : transaction.utr ? (
            <Micro style={styles.detail} numberOfLines={1}>
              UTR {transaction.utr}
            </Micro>
          ) : null}

          {onPress ? <Icon name="dash" size={12} color={p.inkFaint} /> : null}
        </View>
      </View>
    </View>
  );

  if (!onPress) return body;

  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      // The whole stub is one target and one announcement. A screen reader reading the name,
      // then the amount, then the status as three separate nodes makes a list of twenty payments
      // sixty swipes long.
      accessibilityLabel={[
        inbound ? 'Received from' : 'Paid to',
        transaction.counterpartyName ?? transaction.counterparty,
        figure,
        meta.label,
      ].join(', ')}
      accessibilityHint="Opens the receipt"
    >
      {body}
    </Press>
  );
}

/**
 * A stub's date, as a cheque book writes it: `14 Jul`, or `14 Jul 25` across a year boundary.
 *
 * Not "2 hours ago". A counterfoil is a dated record — relative time is for feeds, and it makes
 * a payment history impossible to reconcile against a bank statement, which is the main thing
 * anybody uses one for.
 */
function stubDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const day = at.getDate();
  const month = at.toLocaleString('en-GB', { month: 'short' });
  const thisYear = new Date().getFullYear();
  const year = at.getFullYear();
  return year === thisYear
    ? `${day} ${month}`
    : `${day} ${month} ${String(year).slice(-2)}`;
}

const styles = StyleSheet.create({
  stub: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Space.md,
    paddingVertical: Space.md,
  },
  ruled: { borderBottomWidth: Hairline.base },
  content: { flexGrow: 1, flexShrink: 1, gap: Space.sm },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  who: { flexGrow: 1, flexShrink: 1, gap: 2 },
  figure: { flexShrink: 0, alignItems: 'flex-end', gap: 2, maxWidth: '52%' },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  detail: { flexGrow: 1, flexShrink: 1 },
});
