import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isComputedScore, type ScoreResult } from '@/api';
import {
  Button,
  Header,
  Icon,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Screen,
  Segmented,
  Spinner,
  Text,
  type Segment,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { FactorList } from '@/features/score/components/factor-list';
import { ImprovementList } from '@/features/score/components/improvement-list';
import { ScoreMeter } from '@/features/score/components/score-meter';
import { SCORE_STATE_META } from '@/features/score/score-meta';
import { useScore } from '@/features/score/use-score';
import { Radius, Space, usePalette } from '@/theme';

type View_ = 'why' | 'improve';

const VIEWS: readonly Segment<View_>[] = [
  { value: 'why', label: 'Why this score', icon: 'factors' },
  { value: 'improve', label: 'How to improve', icon: 'improve' },
];

/**
 * My Reputation — the M2 user surface.
 *
 * A component rather than a route because the score is reachable two ways: as the
 * Score TAB and pushed from the passport. Both must render the same screen, and
 * two copies would drift. The route files own their navigator options; this owns
 * the content. (That reasoning is the incumbent's and it is correct.)
 *
 * Every non-score state keeps its own explicit screen with its own next step,
 * because they are not interchangeable: NO_CONSENT routes to M1, INSUFFICIENT_DATA
 * asks for more accounts, EXPIRED asks for re-consent. Collapsing them into "no
 * score yet" would leave the user with nothing to do.
 */
export function ReputationScreen() {
  const { score, loading, computing, error, refetch, compute } = useScore();
  const [view, setView] = useState<View_>('why');
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const computed = score && isComputedScore(score) ? score : null;

  return (
    <Screen
      tabBar
      onRefresh={async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
      }}
      refreshing={refreshing}
    >
      <View style={styles.sheet}>
        <Header
          legend="Reputation"
          title={computed ? 'Your score' : 'Your reputation'}
          lede={
            computed
              ? undefined
              : 'What a lender or landlord would see, built only from data you chose to share.'
          }
        />

        {loading && !score ? <ListSkeleton rows={2} label="Loading your score" /> : null}

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {computed ? (
          <>
            <ScoreMeter score={computed} />

            <View style={styles.explain}>
              <Segmented
                segments={VIEWS}
                value={view}
                onChange={setView}
                label="Score explanation"
              />
              {view === 'why' ? (
                <FactorList factors={computed.factors} />
              ) : (
                <ImprovementList improvements={computed.improvements} />
              )}
            </View>

            <View style={styles.links}>
              <LinkRow
                icon="history"
                title="Score history"
                detail="How it has moved, and under which model version"
                onPress={() => router.push(ROUTES.SCORE.HISTORY)}
              />
              <LinkRow
                icon="scales"
                title="Help us prove this is fair"
                detail="Optional. Never used to calculate your score."
                onPress={() => router.push(ROUTES.SCORE.FAIRNESS)}
              />
            </View>

            <Button
              label={computing ? 'Recomputing…' : 'Recompute my score'}
              variant="secondary"
              icon="refresh"
              loading={computing}
              onPress={() => void compute()}
            />

            {/* Provenance, stated rather than hidden: the holder is entitled to
                know which model priced them, and it is what makes the number
                portable to another institution. */}
            <Micro>
              Scored by {computed.model.name} v{computed.model.version}
              {computed.computedAt
                ? ` on ${new Date(computed.computedAt).toLocaleDateString()}`
                : ''}
              {computed.expiresAt
                ? `. Expires ${new Date(computed.expiresAt).toLocaleDateString()}, with the data-sharing consent behind it.`
                : '.'}
            </Micro>
          </>
        ) : null}

        {score && !isComputedScore(score) ? (
          <EmptyState score={score} computing={computing} onCompute={() => void compute()} />
        ) : null}
      </View>
    </Screen>
  );
}

/** The five non-score states, each with the action that actually resolves it. */
function EmptyState({
  score,
  computing,
  onCompute,
}: {
  score: Exclude<ScoreResult, { state: 'COMPUTED' }>;
  computing: boolean;
  onCompute: () => void;
}) {
  const p = usePalette();
  const meta = SCORE_STATE_META[score.state] ?? {
    icon: 'info' as const,
    title: 'No score yet',
    body: score.message,
    cta: null,
  };

  const act = () => {
    switch (score.state) {
      case 'NO_CONSENT':
      case 'INSUFFICIENT_DATA':
        // Both lead back to M1 — to share for the first time, or to link an
        // account with more history.
        router.push(ROUTES.CONSENT.DASHBOARD);
        return;
      case 'EXPIRED':
        router.push(ROUTES.CONSENT.NEW);
        return;
      case 'FAILED':
        onCompute();
        return;
      default:
    }
  };

  return (
    <Panel pad="lg">
      <View style={styles.empty}>
        <View style={[styles.emptyGlyph, { borderColor: p.rule }]}>
          {score.state === 'PENDING' ? (
            <Spinner size={22} label="Working out your score" />
          ) : (
            <Icon name={meta.icon} size={22} color={p.latent} />
          )}
        </View>

        <Text role="heading" center>
          {meta.title}
        </Text>
        <Text role="bodySm" tone="dim" center style={styles.emptyBody}>
          {meta.body}
        </Text>

        {/* The API's own message, kept alongside our copy rather than replacing
            it: it carries specifics ours cannot, like how many months exist. */}
        {score.state === 'INSUFFICIENT_DATA' ? (
          <Micro center style={styles.emptyBody}>
            {score.monthsCovered > 0
              ? `We have ${score.monthsCovered} month${score.monthsCovered === 1 ? '' : 's'} of history so far.`
              : 'There is no transaction history yet.'}{' '}
            We would rather tell you that than invent a number.
          </Micro>
        ) : null}

        {meta.cta ? (
          <View style={styles.emptyAction}>
            <Button
              label={meta.cta}
              loading={score.state === 'FAILED' && computing}
              onPress={act}
            />
          </View>
        ) : null}
      </View>
    </Panel>
  );
}

function LinkRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: 'history' | 'scales';
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.md}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      style={styles.linkOuter}
    >
      <View style={[styles.link, { borderColor: p.rule, backgroundColor: p.panel }]}>
        <Icon name={icon} size={20} color={p.latent} />
        <View style={styles.linkText}>
          <Text role="title">{title}</Text>
          <Micro tone="dim">{detail}</Micro>
        </View>
        <Icon name="chevronRight" size={16} color={p.inkFaint} weight={1.6} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  explain: { gap: Space.lg },
  links: { gap: Space.sm },
  linkOuter: { alignSelf: 'stretch' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.lg,
  },
  linkText: { flex: 1, gap: 1 },
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
  emptyAction: { alignSelf: 'stretch', marginTop: Space.sm },
});
