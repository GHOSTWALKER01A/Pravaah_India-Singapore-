import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import type { InsuranceQuote } from '@/api/insurance/schemas';
import { Button, Icon, Legend, Micro, Panel, Rule, Text } from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';

/**
 * A decline, with a route back.
 *
 * ## Why this is a whole component and not an error toast
 *
 * A decline is the outcome this product's users have received from every insurer they
 * have ever approached, always with no reason attached. Reproducing that — a red banner
 * saying "not eligible" — while holding their consented financial data would be worse
 * than not offering the product at all: we would have taken their permission, read their
 * bank history, and given back the same silence.
 *
 * So the server records a DECLINE as a priced quote with a written reason, and this
 * screen renders three things a refusal normally lacks:
 *
 *  1. **What was decided**, in plain words, without the word "rejected".
 *  2. **Why**, from the underwriting service's own explanation, which names the band
 *     rather than the person.
 *  3. **What would change it** — a working link to M2's improvement tips, which are real
 *     counterfactuals with recomputed point gains rather than generic advice.
 *
 * ## Why carmine is used sparingly here
 *
 * The world reserves carmine for "the word under pressure". A decline earns the tone on
 * the keyline and the mark — this IS a refusal and softening it would be dishonest — but
 * NOT on the body copy, because a wall of red text reads as an accusation. The sentences
 * are ordinary ink; only the frame is carmine.
 */
export function DeclineNotice({ quote }: { quote: InsuranceQuote }) {
  const p = usePalette();

  return (
    <Panel pad="lg" rule={p.carmine} style={styles.panel}>
      <View style={styles.head}>
        <Icon name="alert" size={20} color={p.carmine} weight={1.7} />
        <View style={styles.headText}>
          <Text role="title">Not available to you yet</Text>
          <Micro tone="dim">
            {quote.product.label} · {quote.coverage.formatted} of cover
          </Micro>
        </View>
      </View>

      <Rule />

      {/*
        The reason, verbatim from the server.

        Not paraphrased and not replaced with a generic string. The underwriting service
        writes a sentence that names the band and points at the fix; a client-side
        "you are not eligible" would discard the one useful thing in the response.
      */}
      {quote.declineReason ? (
        <Text role="body">{quote.declineReason}</Text>
      ) : (
        <Text role="body">
          This cover is not open to your current Pravaah band. It is not a judgement about
          you — the band reflects the cash-flow history shared so far.
        </Text>
      )}

      {quote.explanation.length > 0 ? (
        <View style={styles.reasons}>
          <Legend small tone="faint">
            What the decision was based on
          </Legend>
          {quote.explanation.map((line) => (
            <View key={line} style={styles.reasonRow}>
              <View style={[styles.bullet, { backgroundColor: p.inkFaint }]} />
              <Text role="bodySm" tone="dim" style={styles.reasonText}>
                {line}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <Rule />

      <View style={styles.actions}>
        <Button
          label="See how to improve my score"
          onPress={() => router.push(ROUTES.SCORE.ROOT)}
          variant="primary"
          iconEnd="chevronRight"
        />
        {/*
          A second, quieter route: sharing more data is the other lever, and for a
          thin-file applicant it is the faster one. Naming both is the difference between
          coaching and a dead end.
        */}
        <Button
          label="Share more data to widen my record"
          onPress={() => router.push(ROUTES.CONSENT.NEW)}
          variant="quiet"
        />
      </View>

      <Micro tone="faint">
        Your other cover options are unaffected — this decision applies to this product
        only.
      </Micro>
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { gap: Space.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  headText: { flex: 1, gap: 2 },
  reasons: { gap: Space.sm },
  reasonRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  bullet: { width: 3, height: 3, borderRadius: 2, marginTop: 9 },
  reasonText: { flex: 1 },
  actions: { gap: Space.sm },
});
