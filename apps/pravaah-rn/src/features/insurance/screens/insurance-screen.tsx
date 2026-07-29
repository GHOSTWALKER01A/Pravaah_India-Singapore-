/**
 * THESIS: Insurance for this holder is not a product they shop for — it is an INDEMNITY
 * WRITTEN ON THE SAME NOTE as their passport, priced by the record they already earned. So
 * this surface refuses the arrangement every insurance app ships: a carousel of plans with
 * "from ₹99/month", a quote form, and a lead-capture CTA.
 *
 * OWN-WORLD: The inherited banknote world, in its third artifact. Cover renders as engraved
 * plates with the sum insured and the waiting period given equal weight; a held policy is a
 * counterfoil stub with a torn edge, exactly as a payment is; the price, when it arrives,
 * is struck on the intaglio field because that is where reputation becomes money.
 *
 * STORY: The holder sees that what they are covered for is already theirs to read, learns
 * that no price is shown because the price is personal, gets a figure that is lower than a
 * stranger's for the same cover, and understands the waiting period BEFORE they pay rather
 * than at the moment a claim is refused.
 *
 * FIRST VIEWPORT: What is already held — the live policies as stubs, and any claim still
 * moving — then the covers on offer. Held before offered, because a returning holder's
 * question is "am I covered" and a first-time holder's is "what is there", and only the
 * first of those is urgent.
 *
 * FORM: Sibling surface of an established identity, inherited rather than re-decided. No
 * concept roll was run and none was appropriate.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO, and why each is a defect rather than a taste:
 *
 *  - **It shows no price on a product card.** Pricing is personal — two applicants pay
 *    differently for identical cover — so a "from" price is one the best band alone is
 *    offered and an average is one nobody is quoted. Both teach the user to distrust the
 *    figure they eventually get. The absence is LABELLED rather than left as a gap.
 *  - **It does not hide a lapsed policy.** `activeOnly` is not passed. Hiding lapsed cover
 *    is how somebody discovers they were uninsured at claim time.
 *  - **It does not lead with the marketplace.** A holder with live cover and an open claim
 *    is not shopping.
 */
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import {
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Press,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Radius, Space, usePalette } from '@/theme';

import {
  ClaimStub,
  CoverPlate,
  PolicyStub,
} from '@/features/insurance/components';
import { useClaims } from '@/features/insurance/use-claims';
import { usePolicies, useProducts } from '@/features/insurance/use-insurance';

export function InsuranceScreen() {
  const router = useRouter();
  const p = usePalette();

  const { products, loading: loadingProducts, error: productError, refresh: refreshProducts } =
    useProducts();
  const {
    policies,
    claimable,
    loading: loadingPolicies,
    refreshing,
    refresh: refreshPolicies,
  } = usePolicies();
  const { open: openClaims, refresh: refreshClaims } = useClaims();

  /**
   * Refetch on focus.
   *
   * A premium can be collected, a policy can lapse, and a claim can be decided while the
   * holder is on another tab. Refetching on focus is what stops this screen showing cover
   * as live after a lapse the holder has already been notified about — the one
   * contradiction this surface must never produce.
   */
  useFocusEffect(
    useCallback(() => {
      void refreshPolicies();
      void refreshClaims();
    }, [refreshPolicies, refreshClaims]),
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshPolicies(), refreshProducts(), refreshClaims()]);
  }, [refreshPolicies, refreshProducts, refreshClaims]);

  const held = policies.length > 0;
  const loading = loadingProducts && loadingPolicies;

  return (
    <Screen tabBar showProfile onRefresh={refreshAll} refreshing={refreshing}>
      <View style={styles.sheet}>
        <Header
          title="Cover"
          lede={
            held
              ? 'What you are covered for, and what else is open to you.'
              : 'Insurance priced from the record you already earned — not from a form you fill in.'
          }
        />

        {productError ? <Notice tone="error">{productError}</Notice> : null}

        {loading ? (
          <ListSkeleton rows={3} label="Loading your cover" />
        ) : (
          <>
            {/* ── open claims: the most urgent thing on the screen ──────────── */}
            {openClaims.length > 0 ? (
              <View style={styles.section}>
                <SectionHead
                  title={
                    openClaims.length === 1
                      ? 'Your claim'
                      : `Your ${openClaims.length} claims`
                  }
                />
                <View style={styles.list}>
                  {openClaims.map((claim) => (
                    <ClaimStub
                      key={claim.id}
                      claim={claim}
                      onPress={() => router.push(ROUTES.INSURANCE.CLAIM(claim.id))}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {/* ── what is held ─────────────────────────────────────────────── */}
            {held ? (
              <View style={styles.section}>
                <SectionHead
                  title="Your cover"
                  aside={
                    <Press
                      onPress={() => router.push(ROUTES.INSURANCE.POLICIES)}
                      depth="none"
                      accessibilityRole="button"
                      accessibilityLabel="See all your policies"
                    >
                      <View style={styles.seeAll}>
                        <Legend small tone="inherit" style={{ color: p.field }}>
                          All
                        </Legend>
                        <Icon
                          name="chevronRight"
                          size={13}
                          color={p.field}
                          weight={1.7}
                        />
                      </View>
                    </Press>
                  }
                />
                <View style={styles.list}>
                  {/*
                    At most three on the tab. The wallet screen holds the rest.

                    A tab that listed twelve policies would bury the marketplace below the
                    fold for the holder most likely to buy again.
                  */}
                  {policies.slice(0, 3).map((policy) => (
                    <PolicyStub
                      key={policy.id}
                      policy={policy}
                      onPress={() => router.push(ROUTES.INSURANCE.POLICY(policy.id))}
                    />
                  ))}
                </View>

                {claimable.length > 0 ? (
                  <Press
                    onPress={() => router.push(ROUTES.INSURANCE.CLAIMS)}
                    depth="subtle"
                    radius={Radius.sm}
                    accessibilityRole="button"
                    accessibilityLabel="File or track a claim"
                  >
                    <View style={[styles.claimBar, { borderColor: p.rule }]}>
                      <Icon name="claim" size={16} color={p.field} weight={1.6} />
                      <Text role="bodySmMedium" style={styles.claimBarText}>
                        Make a claim
                      </Text>
                      <Icon
                        name="chevronRight"
                        size={14}
                        color={p.inkFaint}
                        weight={1.6}
                      />
                    </View>
                  </Press>
                ) : null}
              </View>
            ) : null}

            {/* ── the marketplace ──────────────────────────────────────────── */}
            <View style={styles.section}>
              <SectionHead
                title={held ? 'Add more cover' : 'What we cover'}
              />

              {/*
                Why there are no prices here, said once, at the top.

                Without this line the missing price reads as a broken card. With it, the
                absence becomes the product's first honest claim: the number is about YOU,
                so it cannot be printed on a shelf.
              */}
              <Panel pad="md" tone="sunk" notch={false}>
                <View style={styles.whyRow}>
                  <Icon name="dial" size={15} color={p.latent} weight={1.6} />
                  <Micro tone="dim" style={styles.whyText}>
                    Prices are personal, so none are shown here. Pick how much cover you
                    want and we will price it from your Pravaah score — usually below what
                    a stranger would be charged.
                  </Micro>
                </View>
              </Panel>

              {products.length === 0 ? (
                <Panel pad="lg">
                  <View style={styles.empty}>
                    <Icon name="cover" size={30} color={p.inkFaint} weight={1.4} />
                    <Text role="bodySm" tone="dim" center>
                      No cover is on offer right now. This is a catalogue an administrator
                      manages, so it can change without an app update.
                    </Text>
                  </View>
                </Panel>
              ) : (
                <View style={styles.list}>
                  {products.map((product) => (
                    <CoverPlate
                      key={product.id}
                      product={product}
                      onPress={() =>
                        router.push(ROUTES.INSURANCE.COVER(product.id))
                      }
                    />
                  ))}
                </View>
              )}
            </View>
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
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  claimBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
  },
  claimBarText: { flex: 1 },
  whyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  whyText: { flex: 1 },
  empty: { alignItems: 'center', gap: Space.md, paddingVertical: Space.lg },
});
