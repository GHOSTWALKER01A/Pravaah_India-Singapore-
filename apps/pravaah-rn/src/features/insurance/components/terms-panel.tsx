import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, Legend, Micro, Panel, Press, Rule, Text } from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

/**
 * The exclusions, and the non-advice disclaimer.
 *
 * ## Why the exclusions are open by default and the disclaimer is not
 *
 * They serve opposite purposes and deserve opposite treatment.
 *
 * The EXCLUSIONS are the terms that will decide a claim. They are short sentences written
 * for somebody with little insurance literacy, and the whole point of writing them that
 * way is that they get read — so they are open, on the buying screen, above the button.
 * Hiding them behind "view terms" would make the plain language pointless.
 *
 * The DISCLAIMER is a legal statement that must be present and acknowledged. It is
 * collapsed because a paragraph of regulatory prose above the exclusions would push them
 * off the screen, and the exclusions are the part that protects the user. It is still
 * one tap away, it is still acknowledged explicitly on purchase, and its presence is
 * announced rather than implied.
 *
 * ## Why this component takes strings and not a product
 *
 * It renders on a quote, a policy and a product detail. All three carry the same two
 * fields from the API — the server attaches them to every priced surface so a screen that
 * forgot them is a visible omission in one place rather than a missing paragraph in three.
 */
export function TermsPanel({
  exclusions,
  disclaimer,
  insurerNotice,
  /** Product-level context, when this renders before a price exists. */
  waitingPeriodDays,
  freeLookDays,
}: {
  exclusions: string[];
  disclaimer: string;
  insurerNotice?: string;
  waitingPeriodDays?: number;
  freeLookDays?: number;
}) {
  const p = usePalette();
  const [showDisclaimer, setShowDisclaimer] = useState(false);

  return (
    <Panel pad="lg" style={styles.panel}>
      <View style={styles.head}>
        <Legend small tone="faint">
          What is not covered
        </Legend>
        <Micro tone="faint">read this before you buy</Micro>
      </View>

      {exclusions.length > 0 ? (
        <View style={styles.list}>
          {exclusions.map((line) => (
            <View key={line} style={styles.row}>
              {/*
                A carmine dash, not a cross.

                A row of red crosses reads as a list of accusations; a dash reads as a
                deduction from a whole, which is what an exclusion actually is.
              */}
              <View style={[styles.dash, { backgroundColor: p.carmine }]} />
              <Text role="bodySm" style={styles.rowText}>
                {line}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Micro tone="dim">
          No exclusions are listed for this cover. The insurer&apos;s policy wording still
          applies.
        </Micro>
      )}

      {waitingPeriodDays !== undefined || freeLookDays !== undefined ? (
        <>
          <Rule />
          <View style={styles.terms}>
            {waitingPeriodDays !== undefined ? (
              <View style={styles.term}>
                <Icon name="hourglass" size={14} color={p.latent} weight={1.6} />
                <Text role="bodySm" tone="dim" style={styles.termText}>
                  {waitingPeriodDays === 0
                    ? 'Cover starts as soon as the premium is paid.'
                    : `Anything that happens in the first ${waitingPeriodDays} days is not covered. This is what keeps the price low for everyone.`}
                </Text>
              </View>
            ) : null}
            {freeLookDays !== undefined && freeLookDays > 0 ? (
              <View style={styles.term}>
                <Icon name="refresh" size={14} color={p.field} weight={1.6} />
                <Text role="bodySm" tone="dim" style={styles.termText}>
                  Change your mind within {freeLookDays} days and you get every rupee of
                  the premium back.
                </Text>
              </View>
            ) : null}
          </View>
        </>
      ) : null}

      <Rule />

      {/* ── the disclaimer, one tap away ─────────────────────────────────────── */}
      <Press
        onPress={() => setShowDisclaimer((open) => !open)}
        depth="none"
        accessibilityRole="button"
        accessibilityState={{ expanded: showDisclaimer }}
        accessibilityLabel="Important information about this cover"
      >
        <View style={styles.discHead}>
          <Icon name="info" size={14} color={p.inkFaint} weight={1.6} />
          <Legend small tone="faint" style={styles.discLabel}>
            Important information
          </Legend>
          <Icon
            name={showDisclaimer ? 'chevronDown' : 'chevronRight'}
            size={13}
            color={p.inkFaint}
            weight={1.6}
          />
        </View>
      </Press>

      {showDisclaimer ? (
        <View style={styles.disclaimer}>
          <Micro tone="dim">{disclaimer}</Micro>
          {insurerNotice ? (
            /*
              The mock-insurer notice, verbatim from the API.

              Present because a build that quietly presented a demonstration insurer as a
              licensed one would be the single thing that discredits everything else in
              the module. It disappears when a real insurer is behind the interface —
              which is the correct moment for it to disappear.
            */
            <Micro tone="faint">{insurerNotice}</Micro>
          ) : null}
        </View>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { gap: Space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
  list: { gap: Space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  dash: { width: 7, height: Hairline.thick + 0.5, marginTop: 10 },
  rowText: { flex: 1 },
  terms: { gap: Space.sm },
  term: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  termText: { flex: 1 },
  discHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  discLabel: { flex: 1 },
  disclaimer: { gap: Space.sm },
});
