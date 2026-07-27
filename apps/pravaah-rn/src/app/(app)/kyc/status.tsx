import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Header,
  Notice,
  PassportSkeleton,
  Screen,
  SectionHead,
  Spinner,
  Text,
  haptic,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';
import { CHECK_META } from '@/features/kyc/check-labels';
import { KycStepList } from '@/features/kyc/components/kyc-step-list';
import { PassportCard } from '@/features/kyc/components/passport-card';
import { nextCheck, nextRoute } from '@/features/kyc/flow';
import { useKycStatus } from '@/features/kyc/use-kyc-status';
import { Space } from '@/theme';

/** How often to re-check while a decision is pending. */
const POLL_MS = 5000;

export default function KycStatusScreen() {
  const { user } = useAuth();
  // Poll while pending so a reviewer's decision lands here on its own.
  const { status, loading, error, refetch } = useKycStatus({ pollMs: POLL_MS });
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  // The one moment in the app that earns a success haptic: it fires once, when
  // the profile actually becomes VERIFIED, and then the screen hands over.
  const verified = status?.overallStatus === 'VERIFIED';
  useEffect(() => {
    if (!verified) return;
    haptic.cleared();
    const id = setTimeout(() => router.replace(ROUTES.TABS.HOME), 1400);
    return () => clearTimeout(id);
  }, [verified]);

  const pending = status ? nextCheck(status) : null;
  const inReview = status?.overallStatus === 'IN_REVIEW';
  const rejected = status?.overallStatus === 'REJECTED';

  return (
    <Screen
      onRefresh={async () => {
        setRefreshing(true);
        await refetch();
        setRefreshing(false);
      }}
      refreshing={refreshing}
    >
      <Stack.Screen options={{ title: 'Verification' }} />

      <View style={styles.sheet}>
        {loading && !status ? <PassportSkeleton /> : null}

        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}

        {status ? (
          <>
            <PassportCard status={status} pravaahId={user?.pravaahId} />

            {/* Exactly one state message, and it always names what happens next. */}
            {verified ? (
              <View style={styles.settled}>
                <Spinner size={18} label="Opening your passport" />
                <Text role="bodySm" tone="dim">
                  Every check has cleared. Opening your passport…
                </Text>
              </View>
            ) : pending ? (
              <View style={styles.next}>
                <Header title="One more step" lede={CHECK_META[pending]?.subtitle ?? ''} />
                <Button
                  label={`Continue: ${CHECK_META[pending]?.label}`}
                  iconEnd="chevronRight"
                  onPress={() => router.push(nextRoute(status))}
                />
              </View>
            ) : inReview ? (
              <Notice tone="caution" title="With a reviewer">
                Everything is submitted. A person is checking the details that did
                not match exactly — usually a spelling difference between documents.
                This screen updates by itself, so you can close the app.
              </Notice>
            ) : rejected ? (
              <View style={styles.next}>
                <Notice tone="error" title="Verification was declined">
                  The checks below show which one did not clear. You can start again
                  on either corridor — and if you believe this is wrong, the same
                  detail is what support will ask for.
                </Notice>
                <Button label="Start again" onPress={() => router.navigate(ROUTES.TABS.KYC)} />
              </View>
            ) : null}

            <View style={styles.checks}>
              <SectionHead title="Every check" />
              <KycStepList status={status} />
            </View>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm },
  settled: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  next: { gap: Space.lg },
  checks: { gap: Space.lg },
});
