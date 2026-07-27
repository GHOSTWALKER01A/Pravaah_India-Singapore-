import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ConsentSummary } from '@/api';
import {
  Button,
  FieldValue,
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Rule,
  Screen,
  StatusMark,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import {
  CONSENT_STATUS_HINT,
  dataLifeLabel,
  fiTypeLabel,
} from '@/features/consent/consent-meta';
import { useConsents } from '@/features/consent/use-consents';
import { Radius, Space, usePalette } from '@/theme';

/**
 * The consent dashboard — the trust home.
 *
 * Product principle 4: revocation is the money-shot. So this screen's job is to
 * make the list of what Pravaah holds completely legible, and the path to
 * destroying any of it short. The incumbent buried both: every consent was a card
 * whose most prominent element was the purpose sentence, revoke was two screens
 * away with no indication it existed, and the empty state was a 🔓 emoji.
 */
export default function ConsentDashboardScreen() {
  const p = usePalette();
  const { consents, loading, error, refetch } = useConsents();
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const live = consents?.filter((c) => c.status === 'ACTIVE') ?? [];
  const other = consents?.filter((c) => c.status !== 'ACTIVE') ?? [];
  const empty = consents != null && consents.length === 0;

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
      }}
      refreshing={refreshing}
      footer={
        <Button
          label="Share new data"
          icon="plus"
          onPress={() => router.push(ROUTES.CONSENT.NEW)}
        />
      }
    >
      <Stack.Screen options={{ title: 'Data sharing' }} />

      <View style={styles.sheet}>
        <Header
          legend="Account Aggregator"
          title="What you're sharing"
          lede="You decide which financial data powers your reputation, for what purpose, and for how long. Revoke any of it and the data is deleted immediately."
        />

        {loading && !consents ? (
          <ListSkeleton rows={2} label="Loading your consents" />
        ) : null}

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {empty ? (
          <Panel pad="lg">
            <View style={styles.empty}>
              <View style={[styles.emptyGlyph, { borderColor: p.rule }]}>
                <Icon name="consent" size={22} color={p.latent} />
              </View>
              <Text role="heading" center>
                Nothing is shared yet
              </Text>
              <Text role="bodySm" tone="dim" center style={styles.emptyBody}>
                Your verified identity says who you are. A reputation score needs
                what you have actually done with money — and that only moves when
                you approve it, on your Account Aggregator&apos;s own screen.
              </Text>
            </View>
          </Panel>
        ) : null}

        {live.length > 0 ? (
          <View style={styles.group}>
            <Legend tone="latent">{`Live · ${live.length}`}</Legend>
            {live.map((c) => (
              <ConsentPlate key={c.id} consent={c} />
            ))}
          </View>
        ) : null}

        {other.length > 0 ? (
          <View style={styles.group}>
            <Legend tone="faint">Ended</Legend>
            <Panel pad="none">
              {other.map((c, i) => (
                <View key={c.id}>
                  {i > 0 ? <Rule /> : null}
                  <EndedRow consent={c} />
                </View>
              ))}
            </Panel>
          </View>
        ) : null}

        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.flex}>
            Data is encrypted from your bank all the way to Pravaah. The Account
            Aggregator in between carries a sealed envelope — it cannot read the
            contents. Pravaah never asks for a bank password.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

/** A live consent gets a full plate: it is a thing currently happening to you. */
function ConsentPlate({ consent }: { consent: ConsentSummary }) {
  const p = usePalette();
  return (
    <Press
      onPress={() => router.push(ROUTES.CONSENT.DETAIL(consent.id))}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`${consent.purpose}. Status active. Kept for ${dataLifeLabel(consent.dataLifeUnit, consent.dataLifeValue)}.`}
      style={styles.plateOuter}
    >
      <View style={[styles.plate, { borderColor: p.rule, backgroundColor: p.panel }]}>
        <View style={styles.plateHead}>
          <StatusMark status={consent.status} />
          <Icon name="chevronRight" size={15} color={p.inkFaint} weight={1.6} />
        </View>

        <Text role="title">{consent.purpose}</Text>

        <View style={styles.sources}>
          {consent.fiTypes.map((t) => (
            <View key={t} style={[styles.source, { borderColor: p.rule }]}>
              <FieldValue role="fieldSm" tone="dim">
                {fiTypeLabel(t)}
              </FieldValue>
            </View>
          ))}
        </View>

        <Rule />

        <View style={styles.plateFoot}>
          <Legend small tone="faint">
            Kept for
          </Legend>
          <FieldValue role="fieldSm">
            {dataLifeLabel(consent.dataLifeUnit, consent.dataLifeValue)}
          </FieldValue>
        </View>
      </View>
    </Press>
  );
}

/** An ended consent is a record, not an action — so it is a ruled row. */
function EndedRow({ consent }: { consent: ConsentSummary }) {
  const p = usePalette();
  return (
    <Press
      onPress={() => router.push(ROUTES.CONSENT.DETAIL(consent.id))}
      depth="none"
      radius={Radius.sm}
      accessibilityRole="button"
      accessibilityLabel={`${consent.purpose}. ${CONSENT_STATUS_HINT[consent.status]}`}
    >
      <View style={styles.endedRow}>
        <View style={styles.flex}>
          <Text role="bodySmMedium" numberOfLines={1}>
            {consent.purpose}
          </Text>
          <Micro tone="dim">{CONSENT_STATUS_HINT[consent.status]}</Micro>
        </View>
        <StatusMark status={consent.status} labelled={false} size={15} />
        <Icon name="chevronRight" size={14} color={p.inkFaint} weight={1.6} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  group: { gap: Space.md },

  plateOuter: { alignSelf: 'stretch' },
  plate: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Space.lg,
    gap: Space.md,
  },
  plateHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sources: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  source: {
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: Space.sm,
    paddingVertical: 3,
  },
  plateFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
  },

  endedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },

  empty: { alignItems: 'center', gap: Space.md },
  emptyGlyph: {
    width: 52,
    height: 52,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  emptyBody: { maxWidth: 380 },

  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
  flex: { flex: 1 },
});
