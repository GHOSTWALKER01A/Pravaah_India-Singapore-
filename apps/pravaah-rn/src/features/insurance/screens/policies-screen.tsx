/**
 * The policy wallet: everything held, including what has ended.
 *
 * ## Why lapsed and expired cover is NOT hidden
 *
 * `activeOnly` exists on the API and is deliberately not used. Filtering to live cover is
 * the friendlier-looking choice and the wrong one: a policyholder whose cover lapsed needs
 * to SEE that it lapsed, in the place they go to check whether they are insured. Hiding it
 * produces exactly one outcome — somebody discovers they were uninsured at claim time, in
 * a hospital, with a bill.
 *
 * So the list is grouped rather than filtered. Live cover first, ended cover below a rule,
 * with the reason each one ended readable on its own stub.
 */
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  Header,
  Icon,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';

import { PolicyStub } from '@/features/insurance/components';
import { usePolicies } from '@/features/insurance/use-insurance';

export function PoliciesScreen() {
  const router = useRouter();
  const p = usePalette();
  const { policies, loading, refreshing, error, refresh } = usePolicies();

  /**
   * Live, then awaiting, then ended.
   *
   * Three groups rather than two, because `PENDING_PAYMENT` is neither: it is cover the
   * holder has bought and does not yet have, and it needs an action from them. Sorting it in
   * with live policies would misreport their protection; sorting it with ended ones would
   * bury a policy they can still activate.
   */
  const live = policies.filter((policy) => policy.isCovered);
  const awaiting = policies.filter(
    (policy) => policy.status === 'PENDING_PAYMENT',
  );
  const ended = policies.filter(
    (policy) => !policy.isCovered && policy.status !== 'PENDING_PAYMENT',
  );

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.sheet}>
        <Header
          title="Your cover"
          lede="Every policy you hold, including the ones that have ended."
        />

        {error ? <Notice tone="error">{error}</Notice> : null}

        {loading ? (
          <ListSkeleton rows={4} label="Loading your policies" />
        ) : policies.length === 0 ? (
          <Panel pad="lg">
            <View style={styles.empty}>
              <Icon name="cover" size={32} color={p.inkFaint} weight={1.4} />
              <Text role="bodySm" tone="dim" center>
                You do not hold any cover yet. The Cover tab lists what is open to you and
                prices it from your Pravaah score.
              </Text>
            </View>
          </Panel>
        ) : (
          <>
            {live.length > 0 ? (
              <View style={styles.section}>
                <SectionHead title="In force" />
                <View style={styles.list}>
                  {live.map((policy) => (
                    <PolicyStub
                      key={policy.id}
                      policy={policy}
                      onPress={() => router.push(ROUTES.INSURANCE.POLICY(policy.id))}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {awaiting.length > 0 ? (
              <View style={styles.section}>
                <SectionHead title="Waiting on a premium" />
                <View style={styles.list}>
                  {awaiting.map((policy) => (
                    <PolicyStub
                      key={policy.id}
                      policy={policy}
                      onPress={() => router.push(ROUTES.INSURANCE.POLICY(policy.id))}
                    />
                  ))}
                </View>
                <Micro tone="dim">
                  These are not covering you yet. Cover starts when the first premium is
                  collected.
                </Micro>
              </View>
            ) : null}

            {ended.length > 0 ? (
              <View style={styles.section}>
                <Rule />
                <SectionHead title="No longer in force" />
                <View style={styles.list}>
                  {ended.map((policy) => (
                    <PolicyStub
                      key={policy.id}
                      policy={policy}
                      onPress={() => router.push(ROUTES.INSURANCE.POLICY(policy.id))}
                    />
                  ))}
                </View>
                {/*
                  Why the waiting period resets, said here rather than discovered later.

                  A holder whose policy lapsed will assume re-buying restores them to where
                  they were. It does not, and finding that out at claim time is the same
                  betrayal the waiting period itself causes when it is not explained.
                */}
                <Micro tone="faint">
                  Buying again starts a new waiting period. That is why keeping a policy
                  alive through a lean month is worth more than restarting it.
                </Micro>
              </View>
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
  empty: { alignItems: 'center', gap: Space.md, paddingVertical: Space.lg },
});
