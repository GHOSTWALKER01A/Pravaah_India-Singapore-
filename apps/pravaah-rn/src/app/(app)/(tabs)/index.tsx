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
  Header,
  Text,
} from '@/components/ui';
import { ProfileAvatar } from '@/components/ui/profile-avatar';
import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';
import { KycStepList } from '@/features/kyc/components/kyc-step-list';
import {
  PassportCard,
  type PlateFace,
} from '@/features/kyc/components/passport-card';
import { progress } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { PassportVerso } from '@/features/passport/components/passport-verso';
import { usePassportCode } from '@/features/passport/use-passport-code';
import { SCORE_BAND_META } from '@/features/score/score-meta';
import { useScore } from '@/features/score/use-score';
import { Radius, Space, usePalette } from '@/theme';

export default function PassportScreen() {
  const { user } = useAuth();
  const { status, loading, error, refetch } = useKycStatus({ pollMs: 8000 });
  const { score, refetch: refetchScore } = useScore();
  const [refreshing, setRefreshing] = useState(false);
  const p = usePalette();

  const verified = status?.overallStatus === 'VERIFIED';
  const computed = score && isComputedScore(score) ? score : null;

  /**
   * The plate's second face.
   *
   * Gated on the two things a credential requires — a verified identity and a computed
   * score — so a holder who has neither costs no request at all. It matches the gate on
   * `back` below, which is what keeps the plate one-faced for them rather than turning over
   * onto a window that can only apologise.
   *
   * Not polled. A verify code changes when the holder mints one or reports a card lost, and
   * both of those are actions taken from here or from the wallet — so a focus refetch and
   * pull-to-refresh cover it, and an 8-second timer on the first screen would not.
   */
  const {
    code,
    creating,
    refetch: refetchCode,
    create: createCode,
  } = usePassportCode({ enabled: !!verified && computed != null });
  const [face, setFace] = useState<PlateFace>('recto');

  useFocusEffect(
    useCallback(() => {
      void refetch();
      void refetchScore();
    }, [refetch, refetchScore]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refetch(), refetchScore(), refetchCode()]);
    setRefreshing(false);
  };

  if (loading && !status) {
    return (
      <Screen tabBar showProfile>
        <PassportSkeleton />
      </Screen>
    );
  }

  const started = status != null && status.overallStatus !== 'NOT_STARTED';
  const { done, total } = status ? progress(status) : { done: 0, total: 0 };

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
    <Screen tabBar showProfile onRefresh={onRefresh} refreshing={refreshing}>
      <View style={styles.sheet}>
        <Header 
          title="Passport" 
        />
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
            onOpenScore={() => router.push(ROUTES.SCORE.ROOT)}
            onFaceChange={setFace}
            /*
              The verify code, on the plate's own second face. Composed here rather than
              imported by the plate, so the M0 component that draws the document stays free
              of any knowledge of the M3 credential behind it.

              Withheld until a credential is actually possible. A holder who has not
              verified yet has no code and no way to get one from here, and a plate that
              turns over to say "not yet" is a dead end — this screen's whole doctrine is
              one action derived from state, and for them that action is the button below.
            */
            back={
              verified && computed
                ? ({ width, turn }) => (
                    <PassportVerso
                      width={width}
                      pravaahId={user?.pravaahId}
                      code={code}
                      creating={creating}
                      onCreate={() => void createCode()}
                      onRetry={() => void refetchCode()}
                      onIssue={() => router.push(ROUTES.PASSPORT.WALLET)}
                      onOpenCard={() => router.push(ROUTES.PASSPORT.CARD)}
                      onTurn={turn}
                    />
                  )
                : undefined
            }
          />
        ) : null}

        {/* The security model, in the holder's words, and only while they are looking at
            the code. It is the sentence that makes showing the plate to a stranger a calm
            act rather than a risky one, and it belongs on rag — the plate is a document,
            and prose printed on a document is fine print nobody reads. */}
        {face === 'verso' ? (
          <View style={[styles.codeNote, { borderColor: p.rule }]}>
            <Icon name="lock" size={13} color={p.latent} weight={1.3} />
            <Micro style={styles.fineText}>
              A scan starts a request — it reveals nothing on its own. You approve what is
              shared, on this phone, every time. So a photographed code is useless to
              whoever took it.
            </Micro>
          </View>
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
            {/* M3 leads, because it is the only thing here the user OWNS. The score is a
                number in our database; the credential is an artefact they hold, present on
                their own terms, and can have verified abroad without us. */}
            <LinkRow
              icon="passport"
              title="Your reputation passport"
              detail="A credential you own — issue it, share it selectively, revoke it"
              onPress={() => router.push(ROUTES.PASSPORT.WALLET)}
            />
            <LinkRow
              icon="reputation"
              title="Your reputation score"
              detail={`${computed.value ?? '—'} · ${computed.confidenceLabel}`}
              onPress={() => router.push(ROUTES.SCORE.ROOT)}
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
  icon: 'passport' | 'reputation' | 'consent';
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
  /**
   * Sits tight under the plate — `marginTop` cancels the sheet's own gap, because this
   * caption is about the object above it rather than a section of its own. A hairline
   * keyline on the left instead of a Notice: it is a footnote, not an alert.
   */
  codeNote: {
    flexDirection: 'row',
    gap: Space.sm,
    marginTop: -Space.lg,
    borderLeftWidth: StyleSheet.hairlineWidth,
    paddingLeft: Space.md,
  },
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
