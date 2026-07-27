import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError, kycService, type Country, type KycProfileStatus } from '@/api';
import {
  Button,
  Header,
  Icon,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  ProgressRule,
  Screen,
  SectionHead,
  StatusMark,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { CHECK_META } from '@/features/kyc/check-labels';
import { CorridorPlate } from '@/features/kyc/components/country-card';
import {
  REQUIRED_CHECKS,
  nextCheck,
  nextRoute,
  progress,
} from '@/features/kyc/flow';
import { Space, usePalette } from '@/theme';

/**
 * Verify — choose a corridor, or resume the one already in flight.
 *
 * The rails' presentation data. The steps themselves come from REQUIRED_CHECKS so
 * this list can never drift from what the flow will actually ask for.
 */
const CORRIDORS: {
  country: Extract<Country, 'INDIA' | 'SINGAPORE'>;
  code: string;
  title: string;
  tagline: string;
  estimate: string;
}[] = [
  {
    country: 'INDIA',
    code: 'IN',
    title: 'India',
    tagline: 'PAN, Aadhaar and a bank-backed name match',
    estimate: '4 minutes',
  },
  {
    country: 'SINGAPORE',
    code: 'SG',
    title: 'Singapore',
    tagline: 'Singpass Myinfo government identity',
    estimate: '2 minutes',
  },
];

const stepLabels = (country: Country) =>
  REQUIRED_CHECKS[country].map((t) => CHECK_META[t]?.label ?? t);

export default function VerifyScreen() {
  const p = usePalette();
  const [status, setStatus] = useState<KycProfileStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Country | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await kycService.getStatus());
    } catch (err) {
      // A 404 just means this user has not started — not an error to show them.
      if (err instanceof ApiError && err.status === 404) setStatus(null);
      else setError(err instanceof ApiError ? err.message : 'Could not load your status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function start(country: Country) {
    if (busy) return;
    setError(null);
    setBusy(country);
    try {
      router.push(nextRoute(await kycService.start(country)));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not start verification.',
      );
    } finally {
      setBusy(null);
    }
  }

  const overall = status?.overallStatus;
  const inFlight = overall === 'IN_PROGRESS' || overall === 'ACTION_REQUIRED';
  const inReview = overall === 'IN_REVIEW';
  const rejected = overall === 'REJECTED';
  const verified = overall === 'VERIFIED';
  const { done, total } = status ? progress(status) : { done: 0, total: 0 };
  const pending = status ? nextCheck(status) : null;

  return (
    <Screen
      tabBar
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
      refreshing={refreshing}
    >
      <View style={styles.sheet}>
        <Header
          title={verified ? 'Identity verified' : inFlight ? 'Pick up where you left off' : 'Get verified'}
          lede={
            verified
              ? 'Every required check on your corridor has cleared. Your passport is active.'
              : inReview
                ? 'Everything is submitted. A reviewer is looking at it now.'
                : 'One identity, checked once, carried across the corridor. Progress saves as you go — you can stop and come back.'
          }
        />

        {loading && !status ? <ListSkeleton rows={2} label="Loading your verification status" /> : null}

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void load()}>
            {error}
          </Notice>
        ) : null}

        {/* Resume takes priority over everything: someone mid-flow wants one
            button, not a choice they already made. */}
        {inFlight && status ? (
          <Panel pad="none">
            <View style={styles.resume}>
              <View style={styles.resumeHead}>
                <View style={styles.flex}>
                  <Text role="heading">
                    {pending ? CHECK_META[pending]?.label : 'Final checks'}
                  </Text>
                  <Micro tone="dim">
                    {pending ? CHECK_META[pending]?.subtitle : 'Almost there'}
                  </Micro>
                </View>
                <StatusMark status={status.overallStatus} />
              </View>

              <View style={styles.progress}>
                <ProgressRule
                  value={total ? done / total : 0}
                  label={`${done} of ${total} checks cleared`}
                />
                {/* The visible caption. Hidden from assistive tech because the
                    progressbar above already announces exactly this string —
                    without this it is read twice in a row. */}
                <Micro tone="dim" importantForAccessibility="no">
                  {`${done} of ${total} checks cleared`}
                </Micro>
              </View>

              <Button
                label="Continue verification"
                iconEnd="chevronRight"
                onPress={() => router.push(nextRoute(status))}
              />
              <Button
                label="See every check"
                variant="quiet"
                onPress={() => router.push(ROUTES.KYC.STATUS)}
              />
            </View>
          </Panel>
        ) : null}

        {inReview ? (
          <Notice
            tone="caution"
            title="With a reviewer"
            action="See every check"
            onAction={() => router.push(ROUTES.KYC.STATUS)}
          >
            A name that does not match exactly goes to a person rather than being
            auto-declined. Your passport updates here the moment there is a
            decision — you do not need to keep this open.
          </Notice>
        ) : null}

        {verified ? (
          <Notice
            tone="cleared"
            title="Your passport is active"
            action="Open my passport"
            onAction={() => router.navigate(ROUTES.TABS.HOME)}
          >
            Nothing further is needed here.
          </Notice>
        ) : null}

        {rejected ? (
          <Notice tone="error" title="Your last attempt was declined">
            You can start again on either corridor below. If it declines a second
            time, the detail view shows which check did not clear.
          </Notice>
        ) : null}

        {!inReview && !verified ? (
          <View style={styles.corridors}>
            <SectionHead
              title={inFlight ? 'Or switch corridor' : 'Choose your corridor'}
              detail={
                inFlight
                  ? 'Switching restarts verification on the new corridor.'
                  : 'Pick the country whose documents you hold. You can add the other one later.'
              }
            />
            {CORRIDORS.map((c) => (
              <CorridorPlate
                key={c.country}
                country={c.country}
                code={c.code}
                title={c.title}
                tagline={c.tagline}
                steps={stepLabels(c.country)}
                estimate={c.estimate}
                busy={busy === c.country}
                disabled={busy !== null && busy !== c.country}
                onPress={() => void start(c.country)}
              />
            ))}
          </View>
        ) : null}

        <View style={[styles.fine, { borderTopColor: p.rule }]}>
          <Icon name="lock" size={13} color={p.inkFaint} weight={1.3} />
          <Micro style={styles.flex}>
            Each check runs against the authority that issued the document — the
            income-tax database for a PAN, DigiLocker for Aadhaar, your bank for the
            name match. Pravaah stores the result, not the document.
          </Micro>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl },
  resume: { padding: Space.lg, gap: Space.lg },
  resumeHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Space.md,
  },
  progress: { gap: Space.sm },
  corridors: { gap: Space.md },
  flex: { flex: 1 },
  fine: {
    flexDirection: 'row',
    gap: Space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.lg,
  },
});
