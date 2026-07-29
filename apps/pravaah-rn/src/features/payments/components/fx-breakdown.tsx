import { StyleSheet, View } from 'react-native';

import { FieldGrid, FieldRow, Micro, Panel } from '@/components/ui';
import { Space, usePalette } from '@/theme';

import type { QuoteView } from '@/api/payments/schemas';
import { formatCountdown, formatRate } from '../meta';

/**
 * The cross-border breakdown, itemised — and the rate lock beneath it.
 *
 * Every figure the user is entitled to see: what they send, what we charge, the rate we used, the
 * market mid we based it on, and what actually arrives. A remittance product that shows only "they
 * get" is asking to be trusted about the difference, and the difference is where remittance
 * businesses make their money.
 *
 * `midRate` sitting directly under `rate` is the load-bearing detail. Those two lines together are
 * the spread, stated rather than implied, on the screen where the user decides.
 *
 * The rate lock is part of the same component because it qualifies these numbers rather than
 * standing apart from them: the figures above are true only until `validUntil`, and `rateSource ===
 * 'static'` means they came from a configured fallback rather than a live market feed. Saying so
 * plainly is the difference between a quote and a guess presented as a quote.
 */
interface FxBreakdownProps {
  quote: QuoteView;
  /** Milliseconds left on the lock. Owned by the screen, which holds the ticking clock. */
  remainingMs: number;
  expired: boolean;
}

export function FxBreakdown({ quote, remainingMs, expired }: FxBreakdownProps) {
  const p = usePalette();

  return (
    <>
      <Panel pad="none" notch>
        <FieldGrid>
          <FieldRow label="You send" value={quote.youSend.formatted} />
          <FieldRow label="Our fee" value={quote.fee.formatted} />
          {/* Hidden when zero rather than shown as ₹0.00: a nil tax line invites the question
              "why am I being taxed?" on a payment that carries no tax. */}
          {quote.tax.minor !== '0' ? (
            <FieldRow label="Tax on the fee" value={quote.tax.formatted} />
          ) : null}
          <FieldRow
            label="Rate used"
            value={formatRate(
              quote.rate,
              quote.youSend.currency,
              quote.theyGet.currency,
            )}
          />
          <FieldRow
            label="Market rate"
            value={formatRate(
              quote.midRate,
              quote.youSend.currency,
              quote.theyGet.currency,
            )}
          />
          <FieldRow label="They receive" value={quote.theyGet.formatted} />
        </FieldGrid>
      </Panel>

      <View style={styles.lockRow}>
        <Micro style={{ color: expired ? p.carmine : p.latent }}>
          {expired
            ? 'This price has lapsed. Nothing was sent.'
            : `Price held for ${formatCountdown(remainingMs)}`}
        </Micro>
        {quote.rateSource === 'static' ? (
          <Micro>Indicative rate — no live market feed configured</Micro>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  lockRow: { gap: Space.xs },
});
