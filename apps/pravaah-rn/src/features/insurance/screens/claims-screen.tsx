/**
 * Every claim, and the way in to filing one.
 *
 * ## Why filing starts from a POLICY, not from here
 *
 * A claim is always against one policy, and which policy decides everything that follows:
 * the remaining cover, the dates that are covered, and the documents that will be asked for.
 * A "new claim" button here would have to open a policy picker as its first step — so this
 * screen shows the claimable policies directly instead, which is the same tap count with the
 * decision made explicit.
 *
 * If nothing is claimable the screen says WHY — inside a waiting period, or no live cover —
 * rather than showing a disabled button. A greyed control with no explanation is how somebody
 * concludes the app is broken at the moment they most need it to work.
 */
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
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
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Radius, Space, usePalette } from '@/theme';

import { ClaimStub } from '@/features/insurance/components';
import { policyDate } from '@/features/insurance/insurance-meta';
import { useClaims } from '@/features/insurance/use-claims';
import { usePolicies } from '@/features/insurance/use-insurance';

export function ClaimsScreen() {
  const router = useRouter();
  const p = usePalette();
  const { claims, open, loading, refreshing, error, refresh } = useClaims();
  const { policies, loading: loadingPolicies } = usePolicies();

  const settled = claims.filter((claim) => claim.isFinal);

  /**
   * Cover that can actually be claimed against right now.
   *
   * `isCovered && !isInWaitingPeriod`. Both halves are needed: a policy inside its waiting
   * period IS live cover, but a claim against it cannot pay, and offering the button would
   * walk somebody into a refusal the server would issue seconds later.
   */
  const claimable = policies.filter(
    (policy) => policy.isCovered && !policy.isInWaitingPeriod,
  );
  const waiting = policies.filter(
    (policy) => policy.isCovered && policy.isInWaitingPeriod,
  );

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.sheet}>
        <Header
          title="Claims"
          lede="What you have claimed, and what you can claim against."
        />

        {error ? <Notice tone="error">{error}</Notice> : null}

        {loading || loadingPolicies ? (
          <ListSkeleton rows={3} label="Loading your claims" />
        ) : (
          <>
            {/* ── in flight ─────────────────────────────────────────────────── */}
            {open.length > 0 ? (
              <View style={styles.section}>
                <SectionHead title="In progress" />
                <View style={styles.list}>
                  {open.map((claim) => (
                    <ClaimStub
                      key={claim.id}
                      claim={claim}
                      onPress={() => router.push(ROUTES.INSURANCE.CLAIM(claim.id))}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {/* ── start one ────────────────────────────────────────────────── */}
            <View style={styles.section}>
              <SectionHead title="Make a claim" />

              {claimable.length > 0 ? (
                <View style={styles.list}>
                  {claimable.map((policy) => (
                    <Press
                      key={policy.id}
                      onPress={() =>
                        router.push(ROUTES.INSURANCE.CLAIM_NEW(policy.id))
                      }
                      depth="subtle"
                      radius={Radius.sm}
                      accessibilityRole="button"
                      accessibilityLabel={`Claim against ${policy.product.label}. ${policy.remainingCover.formatted} of cover left.`}
                    >
                      <View
                        style={[
                          styles.against,
                          { backgroundColor: p.panel, borderColor: p.rule },
                        ]}
                      >
                        <Icon name="claim" size={17} color={p.field} weight={1.6} />
                        <View style={styles.againstText}>
                          <Text role="bodySmMedium">{policy.product.label}</Text>
                          <Micro tone="dim">
                            {policy.remainingCover.formatted} of cover left
                          </Micro>
                        </View>
                        <Icon
                          name="chevronRight"
                          size={14}
                          color={p.inkFaint}
                          weight={1.6}
                        />
                      </View>
                    </Press>
                  ))}
                </View>
              ) : (
                <Panel pad="lg">
                  <View style={styles.empty}>
                    <Icon name="hourglass" size={28} color={p.inkFaint} weight={1.4} />
                    {/*
                      The reason, not a disabled button.

                      Two distinct cases with two distinct answers: cover exists but is
                      inside its waiting period (wait, and here is the date), or there is no
                      live cover at all (buy some). Collapsing them into "you cannot claim"
                      would leave the first group thinking they had been sold nothing.
                    */}
                    {waiting.length > 0 ? (
                      <>
                        <Text role="bodySm" tone="dim" center>
                          Your cover is still inside its waiting period, so a claim cannot be
                          paid yet.
                        </Text>
                        {waiting.map((policy) => (
                          <Micro key={policy.id} tone="latent">
                            {policy.product.label} — claimable from{' '}
                            {policyDate(policy.waitingPeriodEndsAt)}
                          </Micro>
                        ))}
                      </>
                    ) : (
                      <Text role="bodySm" tone="dim" center>
                        You do not have any live cover to claim against. The Cover tab lists
                        what is open to you.
                      </Text>
                    )}
                  </View>
                </Panel>
              )}
            </View>

            {/* ── settled ─────────────────────────────────────────────────── */}
            {settled.length > 0 ? (
              <View style={styles.section}>
                <Rule />
                <SectionHead title="Settled" />
                <View style={styles.list}>
                  {settled.map((claim) => (
                    <ClaimStub
                      key={claim.id}
                      claim={claim}
                      onPress={() => router.push(ROUTES.INSURANCE.CLAIM(claim.id))}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {claims.length === 0 && claimable.length > 0 ? (
              <Micro tone="faint">
                You have never claimed. Filing one does not affect your premium or your
                Pravaah score.
              </Micro>
            ) : null}
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xxl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  section: { gap: Space.md },
  list: { gap: Space.sm },
  against: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
  },
  againstText: { flex: 1, gap: 1 },
  empty: { alignItems: 'center', gap: Space.sm, paddingVertical: Space.md },
});
