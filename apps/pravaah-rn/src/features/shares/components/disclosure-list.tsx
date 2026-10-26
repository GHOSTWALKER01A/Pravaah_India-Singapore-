import { StyleSheet, View } from 'react-native';

import { Icon, Legend, Micro, Panel, Text } from '@/components/ui';
import { Radius, Space, usePalette } from '@/theme';

import { isYesNoClaim, predicateQuestion } from '../share-meta';

/**
 * What left the phone, and what did not — the body of every receipt.
 *
 * Three groups, in the order a person asks about them: the details they handed over, the
 * yes/no questions those details answered, and what they kept back. The yes/no group is
 * separate on purpose: "Good or better" appearing in a list next to "Passport number"
 * would read as the same kind of disclosure, and it is not — it is one bit, signed.
 */
export function DisclosureList({
  shared,
  questions,
  withheld,
}: {
  shared: { claim: string; label: string }[];
  questions: string[];
  withheld: { claim: string; label: string }[];
}) {
  const p = usePalette();

  return (
    <View style={styles.stack}>
      <Panel>
        <Legend>You shared</Legend>
        {shared.length === 0 ? (
          <Text role="bodySm" tone="dim" style={styles.first}>
            No details — only proof that you hold a live Pravaah passport.
          </Text>
        ) : (
          shared.map((item) => (
            <View key={item.claim} style={styles.row}>
              <Icon name="check" size={14} color={p.cleared} weight={1.8} />
              <Text role="bodySm" style={styles.rowText}>
                {item.label}
              </Text>
              {isYesNoClaim(item.claim) ? (
                <View style={[styles.tag, { borderColor: p.rule }]}>
                  <Micro tone="dim">yes/no</Micro>
                </View>
              ) : null}
            </View>
          ))
        )}
      </Panel>

      {questions.length > 0 ? (
        <Panel tone="sunk">
          <Legend>Questions answered</Legend>
          {questions.map((key) => (
            <View key={key} style={styles.row}>
              <Icon name="scales" size={14} color={p.latent} weight={1.5} />
              <Text role="bodySm" style={styles.rowText}>
                {predicateQuestion(key)}
              </Text>
            </View>
          ))}
          <Micro style={styles.note}>
            They received a yes or a no, signed by Pravaah — never your score, and never
            your band.
          </Micro>
        </Panel>
      ) : null}

      {withheld.length > 0 ? (
        <Panel tone="sunk">
          <Legend>Kept private</Legend>
          {withheld.map((item) => (
            <View key={item.claim} style={styles.row}>
              <Icon name="dash" size={14} color={p.inkFaint} weight={1.8} />
              <Text role="bodySm" tone="dim" style={styles.rowText}>
                {item.label}
              </Text>
            </View>
          ))}
          <Micro style={styles.note}>
            They were told you chose not to share these — not that the answer was no.
          </Micro>
        </Panel>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: Space.sm },
  first: { marginTop: Space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginTop: Space.xs,
  },
  rowText: { flexShrink: 1 },
  tag: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.xs,
  },
  note: { marginTop: Space.sm },
});
