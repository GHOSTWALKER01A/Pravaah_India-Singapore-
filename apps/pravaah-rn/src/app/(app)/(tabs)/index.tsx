import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isComputedScore } from '@/api';
import {
  Button,
  Icon,
  Micro,
  Notice,
  PassportSkeleton,
  Press,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';
import { KycStepList } from '@/features/kyc/components/kyc-step-list';
import { PassportCard } from '@/features/kyc/components/passport-card';
import { progress } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { SCORE_BAND_META } from '@/features/score/score-meta';
import { useScore } from '@/features/score/use-score';
import { Radius, Space, usePalette } from '@/theme';

/**
 * The Passport tab — the note, and what it still needs.
 *
 * The incumbent stacked six things down this screen at equal weight: the card, a
 * score teaser, a "Verification checks" heading with the check list, a
 * "Start/Continue" button, an "Unlock your reputation" section, and two more
 * buttons — four calls to action on one screen, with no answer to "what do I do
 * now?".
 *
 * There is exactly one next action here at any moment, and it is derived from the
 * state rather than all being rendered at once.
 */
export default function PassportScreen() {
  const { user } = useAuth();
  // Poll while a decision is pending so a reviewer's verdict lands on its own.
  const { status, loading, error, refetch } = useKycStatus({ pollMs: 8000 });
  const { score, refetch: refetchScore } = useScore();
  const [refreshing, setRefreshing] = useState(false);
  const p = usePalette();

  useFocusEffect(
    useCallback(() => {
      void refetch();
      void refetchScore();
    }, [refetch, refetchScore]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetch(), refetchScore()]);
    setRefreshing(false);
  }, [refetch, refetchScore]);

  if (loading && !status) {
    return (
      <Screen tabBar>
        <PassportSkeleton />
      </Screen>
    );
  }

  const verified = status?.overallStatus === 'VERIFIED';
  const started = status != null && status.overallStatus !== 'NOT_STARTED';
  const { done, total } = status ? progress(status) : { done: 0, total: 0 };

  const computed = score && isComputedScore(score) ? score : null;
  const latent =
    computed && computed.value != null
      ? {
          value: computed.value,
          label: computed.band ? SCORE_BAND_META[computed.band].label : '—',
          low: computed.bandLow ?? computed.value,
          high: computed.bandHigh ?? computed.value,
        }
      : null;

  return (
    <Screen tabBar onRefresh={onRefresh} refreshing={refreshing}>
      <View style={styles.sheet}>
        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {status ? (
          <PassportCard
            status={status}
            pravaahId={user?.pravaahId}
            score={latent}
            onOpenScore={() => router.navigate(ROUTES.TABS.SCORE)}
          />
        ) : null}

        {/* The single next action, chosen by state. Never more than one. */}
        {!verified ? (
          <View style={styles.action}>
            <Button
              label={started ? 'Continue verification' : 'Start verification'}
              icon="verify"
              onPress={() => router.navigate(ROUTES.TABS.KYC)}
            />
            <Micro center>
              {started
                ? `${done} of ${total} checks cleared · progress is saved as you go`
                : 'About 4 minutes. You can stop and resume at any point.'}
            </Micro>
          </View>
        ) : !computed ? (
          <View style={styles.action}>
            <Button
              label="Share data to build your score"
              icon="consent"
              onPress={() => router.push(ROUTES.CONSENT.DASHBOARD)}
            />
            <Micro center>
              Your identity is verified. A reputation score needs your financial
              history, shared through the Account Aggregator — and revocable at
              any time.
            </Micro>
          </View>
        ) : null}

        {/* Verified holders get the two places the credential leads, as quiet
            rows rather than a second and third primary button. */}
        {verified && computed ? (
          <View style={styles.links}>
            <LinkRow
              icon="reputation"
              title="Your reputation score"
              detail={`${computed.value ?? '—'} · ${computed.confidenceLabel}`}
              onPress={() => router.navigate(ROUTES.TABS.SCORE)}
            />
            <LinkRow
              icon="consent"
              title="Data sharing"
              detail="Review or revoke what powers your score"
              onPress={() => router.push(ROUTES.CONSENT.DASHBOARD)}
            />
          </View>
        ) : null}

        <View style={styles.checks}>
          <SectionHead
            title="Verification"
            detail={
              status
                ? `${done} of ${total} checks cleared on the ${corridorName(status.country)} corridor`
                : 'Not started yet'
            }
          />
          {status ? (
            <KycStepList status={status} />
          ) : (
            <Text role="bodySm" tone="dim">
              Nothing to show yet. Verification takes about four minutes and you
              can pause at any step.
            </Text>
          )}
        </View>

        {/* Microtext: the audit line under the surface, as a note carries it. */}
        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.fineText}>
            Documents are encrypted and shared only with the verification provider
            each check requires. Nothing is shared to build a score until you
            approve it separately.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

function corridorName(country: string): string {
  return country === 'INDIA' ? 'India' : country === 'SINGAPORE' ? 'Singapore' : 'India–Singapore';
}

function LinkRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: 'reputation' | 'consent';
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
  // Deliberately not a uniform gap. The note owns its own space, the action sits
  // close to it because it is about it, and the sections below breathe apart.
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  action: { gap: Space.md, marginTop: -Space.sm },
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
  checks: { gap: Space.lg, marginTop: Space.sm },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
    marginTop: Space.sm,
  },
  fineText: { flex: 1 },
});
