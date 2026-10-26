import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Screen,
  Segmented,
  Text,
  type Segment,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';

import { ShareRow } from '../components/share-row';
import { useShares, type ShareFilter } from '../use-shares';

const FILTERS: readonly Segment<ShareFilter>[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'ALL', label: 'All' },
];

const EMPTY: Record<ShareFilter, { title: string; body: string }> = {
  ACTIVE: {
    title: 'No organisation holds your data',
    body: 'When you share your passport with a lender, insurer, employer or landlord, it appears here with exactly what you shared and how long they may keep it — and a button to withdraw.',
  },
  WITHDRAWN: {
    title: 'Nothing withdrawn',
    body: 'Shares you withdraw are kept here as a record of when you did it and who was told.',
  },
  EXPIRED: {
    title: 'Nothing expired yet',
    body: 'Every share has a retention term. When it runs out, Pravaah deletes its copy and the share moves here.',
  },
  ALL: {
    title: 'Nothing shared with an organisation yet',
    body: 'Only registered organisations appear here. People who scanned your code are in “Who has seen it”.',
  },
};

/**
 * "Shared with organisations" — every consent receipt the holder holds.
 *
 * This is the transparency centrepiece of M7, and it defaults to ACTIVE on purpose: the
 * question a person opens it with is "who has my data right now", not "everything I have
 * ever done". The other filters are one tap away for the record.
 *
 * It is kept apart from "Who has seen it" (the presentation log) because the two answer
 * different questions. That log is every event — people, failures included. This is the
 * set of standing permissions an organisation holds, each one withdrawable.
 */
export function SharesScreen() {
  const [filter, setFilter] = useState<ShareFilter>('ACTIVE');
  const { items, total, hasMore, loading, loadingMore, error, refetch, loadMore } =
    useShares(filter);
  const [refreshing, setRefreshing] = useState(false);
  const p = usePalette();

  // Returning from a receipt after withdrawing must not show the row as still active.
  // Skipped on the very first focus, which the hook's own mount load already covers.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void refetch();
    }, [refetch]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <Header
        title="Shared with organisations"
        lede="Who holds what you shared, for how long — and your right to take it back."
      />

      <View style={styles.sheet}>
        <Segmented
          segments={FILTERS}
          value={filter}
          onChange={setFilter}
          label="Show shares"
        />

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {loading && items.length === 0 ? (
          <ListSkeleton rows={4} label="Loading your shares" />
        ) : items.length === 0 && !error ? (
          <Panel tone="sunk">
            <Legend>{EMPTY[filter].title}</Legend>
            <Text role="bodySm" tone="dim" style={styles.emptyBody}>
              {EMPTY[filter].body}
            </Text>
          </Panel>
        ) : (
          <View style={styles.list}>
            {filter === 'ACTIVE' && total > 0 ? (
              <Micro tone="dim">
                {total} {total === 1 ? 'organisation holds' : 'organisations hold'} something
                you shared.
              </Micro>
            ) : null}
            {items.map((receipt) => (
              <ShareRow
                key={receipt.id}
                receipt={receipt}
                onPress={() => router.push(ROUTES.PASSPORT.SHARE(receipt.id))}
              />
            ))}
            {hasMore ? (
              <Button
                label="Show more"
                variant="quiet"
                loading={loadingMore}
                onPress={() => void loadMore()}
              />
            ) : null}
          </View>
        )}

        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.fineText}>
            Withdrawing deletes Pravaah’s copy at once and tells the organisation to delete
            theirs. It cannot unsend what they already received — which is why every share
            starts with you choosing exactly what to send.
          </Micro>
        </View>

        <Button
          label="People who scanned your code"
          variant="quiet"
          inline
          icon="history"
          onPress={() => router.push(ROUTES.PASSPORT.HISTORY)}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm },
  list: { gap: Space.sm },
  emptyBody: { marginTop: Space.xs },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  fineText: { flex: 1 },
});
