import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { router } from 'expo-router';

import { ApiError, passportService } from '@/api';
import type { ShareRecord } from '@/api';
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
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';

/**
 * Share history — the transparency half of selective disclosure.
 *
 * Choosing what to share only means something if the holder can later see what they shared,
 * with whom, and when. Without this screen the consent flow is a promise; with it, it is a
 * record the user can audit.
 *
 * Failed shares are listed too, and deliberately. A run of failures against one passport is
 * exactly the shape an attempted theft makes, and hiding them would keep the one person best
 * placed to notice — the owner — in the dark.
 */
export function HistoryScreen() {
  const [records, setRecords] = useState<ShareRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = usePalette();

  const load = useCallback(async () => {
    try {
      setRecords(await passportService.history());
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load your history.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <Screen>
        <Header title="Who has seen it" />
        <ListSkeleton rows={5} label="Loading your share history" />
      </Screen>
    );
  }

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <Header title="Who has seen it" />
      <View style={styles.sheet}>
        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void load()}>
            {error}
          </Notice>
        ) : null}

        {/* This log is every EVENT. What an organisation still HOLDS — and the power to
            withdraw it — lives on the consent receipts, one tap away. */}
        <Button
          label="Shared with organisations — manage and withdraw"
          variant="quiet"
          inline
          icon="receipt"
          onPress={() => router.push(ROUTES.PASSPORT.SHARES)}
        />

        {records.length === 0 ? (
          <Panel tone="sunk">
            <Legend>Nothing shared yet</Legend>
            <Text role="bodySm" tone="dim">
              Every time you show your passport to someone, it is recorded here — who they
              were, exactly which details you chose to share, and when. Nothing is ever
              shared without you approving it on this phone.
            </Text>
          </Panel>
        ) : (
          records.map((record) => (
            <Panel key={record.id} tone={record.valid ? 'panel' : 'sunk'}>
              <View style={styles.head}>
                <View style={styles.headText}>
                  <Text role="title">{record.verifier}</Text>
                  <Micro tone="dim">
                    {formatWhen(record.presentedAt)}
                    {record.verifierCountry ? ` · ${record.verifierCountry}` : ''}
                    {` · ${channelLabel(record.channel)}`}
                  </Micro>
                </View>
                <Icon
                  name={record.valid ? 'check' : 'alert'}
                  size={16}
                  color={record.valid ? p.cleared : p.carmine}
                  weight={1.8}
                />
              </View>

              {record.disclosedClaims.length === 0 ? (
                <Micro tone="dim">
                  You proved you hold a live passport, and shared no details at all.
                </Micro>
              ) : (
                <View style={styles.claims}>
                  {record.disclosedClaims.map((claim) => (
                    <View key={claim.claim} style={styles.claimRow}>
                      <Icon name="dash" size={12} color={p.inkFaint} weight={1.6} />
                      <Text role="bodySm">{claim.label}</Text>
                    </View>
                  ))}
                </View>
              )}

              {!record.valid ? (
                <Micro tone="carmine">
                  This share was refused. If it was not you, revoke your passport and issue a
                  new one.
                </Micro>
              ) : !record.holderVerified ? (
                <Micro tone="dim">
                  Shared without a device signature — a weaker proof than usual.
                </Micro>
              ) : null}
            </Panel>
          ))
        )}
      </View>
    </Screen>
  );
}

function channelLabel(channel: string): string {
  switch (channel) {
    case 'QR':
      return 'scanned';
    case 'NFC':
      return 'tapped';
    case 'DEEPLINK':
      return 'from a link';
    default:
      return 'over the internet';
  }
}

/** Relative for the recent past, absolute once "3 days ago" stops being useful. */
function formatWhen(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 6) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return then.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const styles = StyleSheet.create({
  sheet: { gap: Space.sm, paddingTop: Space.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  headText: { flex: 1, gap: 1 },
  claims: { gap: 2, marginTop: Space.xs },
  claimRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
});
