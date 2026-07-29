import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import {
  Button,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { Hairline, Space, usePalette } from '@/theme';

import { ROUTES } from '@/constants/routes.constants';
import { Perforation } from '@/features/payments/components';
import { formatMinor } from '@/features/payments/money';
import { LEDGER_LEG_LABEL } from '@/features/payments/meta';
import { useStatement } from '@/features/payments/use-wallet';

import type { StatementEntry } from '@/api/payments/schemas';

/**
 * The passbook — every ledger movement, in order.
 *
 * NOT the payment list. That distinction is the whole reason this screen exists: a payment list
 * says what the user tried to do, and this says what happened to their money. The fee is its own
 * line. The reserve is its own line. A refund is its own line, in the opposite direction, on its
 * own date. When somebody disputes a balance, an itemised ledger is the document that answers
 * them and a list of transactions is not.
 *
 * Entries are grouped by DAY with the day's own heading, the way a passbook is ruled — which also
 * means a reader scanning for "what happened on the 14th" finds it by date rather than by counting
 * rows.
 */
export function StatementScreen() {
  const router = useRouter();
  const p = usePalette();
  const { entries, loading, loadingMore, error, hasMore, loadMore, refresh } =
    useStatement();

  const days = groupByDay(entries);

  return (
    <Screen scroll onRefresh={refresh} refreshing={false}>
      <Stack.Screen options={{ title: 'Statement' }} />

      <SectionHead
        title="Statement"
        detail="Every movement in your wallet, taken straight from the ledger."
      />

      {error ? (
        <Notice tone="error" title="Could not load your statement" action="Try again" onAction={refresh}>
          {error}
        </Notice>
      ) : null}

      {loading ? (
        <ListSkeleton rows={8} label="Loading your statement" />
      ) : entries.length === 0 ? (
        <View style={[styles.empty, { borderColor: p.rule }]}>
          <Text role="bodySm" tone="dim" center>
            Nothing has moved yet.
          </Text>
          <Micro center>
            Once you add money or make a payment, every movement appears here as its own
            line.
          </Micro>
        </View>
      ) : (
        <>
          {days.map((day) => (
            <View key={day.key} style={styles.day}>
              <Legend small>{day.label}</Legend>
              <Panel pad="none" notch>
                {day.entries.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? <Rule /> : null}
                    <StatementRow
                      entry={entry}
                      onPress={
                        entry.transaction
                          ? () => router.push(ROUTES.PAY.RECEIPT(entry.transaction!.id))
                          : undefined
                      }
                    />
                  </View>
                ))}
              </Panel>
            </View>
          ))}

          {hasMore ? (
            <Button
              label={loadingMore ? 'Loading…' : 'Show older'}
              variant="secondary"
              loading={loadingMore}
              onPress={loadMore}
            />
          ) : (
            // The end of the book, marked as an edge rather than just stopping. A list that
            // simply ends leaves the reader unsure whether more failed to load.
            <View style={styles.end}>
              <Perforation edge="top" />
              <Micro center>That is the whole statement.</Micro>
            </View>
          )}
        </>
      )}

      <Micro>
        Every line above is one entry in a double-entry ledger, which is why the balance can
        always be reconstructed from it. A payment that fails returns in full; one the network
        confirms late is never paid twice.
      </Micro>
    </Screen>
  );
}

function StatementRow({
  entry,
  onPress,
}: {
  entry: StatementEntry;
  onPress?: () => void;
}) {
  const p = usePalette();
  const credit = entry.direction === 'CREDIT';

  const body = (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text role="bodySm" numberOfLines={1}>
          {/*
            The LEG is the primary label, not the counterparty. On a ledger statement the reader
            needs to know WHAT this movement was — a fee, a reserve, a refund — because that is
            what makes an unexpected line explicable.
          */}
          {LEDGER_LEG_LABEL[entry.leg] ?? entry.leg}
        </Text>
        <Micro numberOfLines={1}>
          {entry.transaction?.counterpartyName ??
            entry.transaction?.counterparty ??
            'Pravaah'}
          {' · '}
          {timeOf(entry.postedAt)}
        </Micro>
      </View>

      <Text
        role="valueSm"
        style={{ color: credit ? p.cleared : p.ink }}
        numberOfLines={1}
      >
        {credit ? '+' : '−'}
        {formatMinor(entry.amount.minor, entry.amount.currency)}
      </Text>
    </View>
  );

  if (!onPress) return body;
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${LEDGER_LEG_LABEL[entry.leg] ?? entry.leg}, ${
        credit ? 'credit' : 'debit'
      } ${entry.amount.formatted}`}
      accessibilityHint="Opens the payment this belongs to"
    >
      {body}
    </Press>
  );
}

/** Group into ruled days, newest first. The server already returns them in order. */
function groupByDay(entries: StatementEntry[]): {
  key: string;
  label: string;
  entries: StatementEntry[];
}[] {
  const out: { key: string; label: string; entries: StatementEntry[] }[] = [];
  for (const entry of entries) {
    const at = new Date(entry.postedAt);
    const key = Number.isNaN(at.getTime())
      ? 'unknown'
      : at.toISOString().slice(0, 10);
    const last = out[out.length - 1];
    if (last?.key === key) last.entries.push(entry);
    else out.push({ key, label: dayLabel(at), entries: [entry] });
  }
  return out;
}

/**
 * `Today`, `Yesterday`, or a full date.
 *
 * Relative labels only for the two days a person actually thinks of relatively. "3 days ago" is
 * useless for reconciling against a bank statement, which is the main thing this screen is for.
 */
function dayLabel(at: Date): string {
  if (Number.isNaN(at.getTime())) return 'Unknown date';
  const today = new Date();
  const days = Math.floor(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) /
      86_400_000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: at.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function timeOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  day: { gap: Space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 48,
  },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  end: { gap: Space.sm, paddingTop: Space.sm },
  empty: {
    borderWidth: Hairline.base,
    borderStyle: 'dashed',
    borderRadius: 5,
    paddingVertical: Space.xxl,
    paddingHorizontal: Space.lg,
    gap: Space.xs,
  },
});
