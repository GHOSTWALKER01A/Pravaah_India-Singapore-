/**
 * One policy, in full.
 *
 * Ordered by what the holder actually asks, in sequence: am I covered, what is it worth,
 * what do I owe, what is not covered, and what can I do about it. The two irreversible
 * actions — filing a claim and cancelling — sit at the bottom, and cancelling is gated
 * behind a confirmation because inside the free-look window it destroys cover in exchange
 * for a refund, and outside it destroys cover for nothing.
 */
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ApiError } from '@/api';
import { insuranceService } from '@/api/insurance/services';
import {
  Button,
  Header,
  Icon,
  Legend,
  Micro,
  Notice,
  Panel,
  PassportSkeleton,
  Press,
  Rule,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Radius, Space, usePalette } from '@/theme';
import { useIdempotencyKey } from '@/features/payments/use-idempotency-key';

import {
  ClaimStub,
  PolicyCertificate,
  TermsPanel,
} from '@/features/insurance/components';
import { policyDate, relativeDays } from '@/features/insurance/insurance-meta';
import { useClaims } from '@/features/insurance/use-claims';
import { usePolicy } from '@/features/insurance/use-insurance';

export function PolicyScreen({ policyId }: { policyId: string }) {
  const router = useRouter();
  const p = usePalette();
  const { policy, loading, error, refresh } = usePolicy(policyId);
  const { claims } = useClaims(policyId);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryShortfall, setRetryShortfall] = useState<string | null>(null);

  const { key: retryKey, reset: resetRetryKey } = useIdempotencyKey();

  /**
   * Retry the first premium.
   *
   * Its own action rather than sending the holder back to buy, because the policy already
   * exists at the agreed price — re-buying would put them through underwriting again at a
   * price that may have moved. Nobody should be repriced for having had an empty wallet on
   * the day they decided to buy cover.
   */
  const onRetryPremium = async () => {
    if (!policy) return;
    setBusy(true);
    setActionError(null);
    setRetryShortfall(null);
    try {
      const result = await insuranceService.retryPremium(policy.id, retryKey);
      if (!result.collected) {
        setRetryShortfall(result.shortfall?.formatted ?? null);
        setActionError(result.message);
        /**
         * A NEW key for the next attempt.
         *
         * The previous one is now bound to a completed-and-failed request. Reusing it after
         * the holder has topped up would replay the failure rather than attempting a fresh
         * collection — the one case `useIdempotencyKey().reset` exists for.
         */
        resetRetryKey();
      }
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : 'Could not collect the premium just now.',
      );
    } finally {
      setBusy(false);
    }
  };

  const onCancel = () => {
    if (!policy) return;
    const refundable = policy.canCancelForFullRefund;

    Alert.alert(
      refundable ? 'Cancel and get a full refund?' : 'Cancel this cover?',
      refundable
        ? `You are inside the free-look window, so the whole premium comes back to your wallet. Your cover ends immediately.`
        : `Your cover ends immediately and the premium already paid is not refunded. You would need to buy again, and the waiting period would start over.`,
      [
        { text: 'Keep my cover', style: 'cancel' },
        {
          text: refundable ? 'Cancel and refund' : 'Cancel cover',
          style: 'destructive',
          onPress: () => void doCancel(),
        },
      ],
    );
  };

  const doCancel = async () => {
    if (!policy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await insuranceService.cancel(policy.id);
      await refresh();
      if (result.refunded && result.refundAmount) {
        Alert.alert(
          'Cover cancelled',
          `${result.refundAmount.formatted} is back in your Pravaah wallet.`,
        );
      }
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'Could not cancel this policy.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <PassportSkeleton />
      </Screen>
    );
  }

  if (error || !policy) {
    return (
      <Screen>
        <View style={styles.sheet}>
          <Header title="Policy" />
          <Notice tone="error">{error ?? 'This policy could not be found.'}</Notice>
        </View>
      </Screen>
    );
  }

  const awaitingPremium = policy.status === 'PENDING_PAYMENT';
  const canClaim = policy.isCovered && !policy.isInWaitingPeriod;
  const canCancel = policy.status === 'ACTIVE' || policy.status === 'GRACE';

  return (
    <Screen
      footer={
        awaitingPremium ? (
          <Button
            label={busy ? 'Collecting…' : 'Pay the first premium'}
            onPress={() => void onRetryPremium()}
            loading={busy}
          />
        ) : canClaim ? (
          <Button
            label="Make a claim"
            onPress={() => router.push(ROUTES.INSURANCE.CLAIM_NEW(policy.id))}
            icon="claim"
          />
        ) : undefined
      }
    >
      <View style={styles.sheet}>
        {actionError ? (
          <Notice tone={retryShortfall ? 'caution' : 'error'}>
            {actionError}
            {retryShortfall ? ` You are ${retryShortfall} short.` : ''}
          </Notice>
        ) : null}

        {/* The certificate. The whole answer to "am I covered". */}
        <PolicyCertificate policy={policy} />

        {/* ── awaiting the first premium ─────────────────────────────────────── */}
        {awaitingPremium ? (
          <Panel pad="lg" rule={p.latent} style={styles.block}>
            <View style={styles.blockHead}>
              <Icon name="alert" size={17} color={p.latent} weight={1.7} />
              <Text role="bodySmMedium" style={styles.blockTitle}>
                Your cover has not started
              </Text>
            </View>
            <Text role="bodySm" tone="dim">
              The premium of {policy.premium.formatted} could not be taken from your
              Pravaah wallet. Nothing is charged and no cover is in force until it is —
              which is why the policy is held here rather than quietly activated.
            </Text>
            <Button
              label="Add money to my wallet"
              onPress={() => router.push(ROUTES.PAY.TOPUP)}
              variant="secondary"
              iconEnd="chevronRight"
            />
          </Panel>
        ) : null}

        {/* ── inside the waiting period ─────────────────────────────────────── */}
        {policy.isInWaitingPeriod ? (
          <Panel pad="lg" rule={p.latent} style={styles.block}>
            <View style={styles.blockHead}>
              <Icon name="hourglass" size={17} color={p.latent} weight={1.7} />
              <Text role="bodySmMedium" style={styles.blockTitle}>
                {policy.waitingPeriodDaysRemaining}{' '}
                {policy.waitingPeriodDaysRemaining === 1 ? 'day' : 'days'} until you can
                claim
              </Text>
            </View>
            {/*
              Stated bluntly, twice, with a date.

              This is the term that produces the refusal policyholders experience as
              betrayal. Saying it here — on the screen they will open when something happens
              — is the difference between a term they agreed to and one they were subjected
              to.
            */}
            <Text role="bodySm" tone="dim">
              Anything that happens before {policyDate(policy.waitingPeriodEndsAt)} is not
              covered by this policy, even if you file the claim later. This waiting period
              is what keeps the premium affordable for everyone.
            </Text>
          </Panel>
        ) : null}

        {/* ── premium ───────────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHead
            title="Premium"
            aside={
              <Press
                onPress={() => router.push(ROUTES.INSURANCE.PREMIUMS(policy.id))}
                depth="none"
                accessibilityRole="button"
                accessibilityLabel="See every premium payment"
              >
                <View style={styles.seeAll}>
                  <Legend small tone="inherit" style={{ color: p.field }}>
                    History
                  </Legend>
                  <Icon name="chevronRight" size={13} color={p.field} weight={1.7} />
                </View>
              </Press>
            }
          />
          <Panel pad="none">
            <Row
              label="Amount"
              value={`${policy.premium.formatted} ${
                policy.frequency === 'MONTHLY' ? 'every month' : 'once'
              }`}
            />
            {policy.nextPremiumDueAt ? (
              <>
                <Rule />
                <Row
                  label="Next due"
                  value={`${policyDate(policy.nextPremiumDueAt)} · ${relativeDays(
                    policy.nextPremiumDueAt,
                  )}`}
                />
              </>
            ) : null}
            <Rule />
            <Row
              label="Taken from"
              value="Your Pravaah wallet"
            />
          </Panel>
          {policy.frequency === 'MONTHLY' ? (
            <Micro tone="faint">
              If a premium cannot be taken, your cover stays live for a further 7 days
              while we retry. It only lapses after that.
            </Micro>
          ) : null}
        </View>

        {/* ── claims on this policy ────────────────────────────────────────── */}
        {claims.length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="Claims on this policy" />
            <View style={styles.list}>
              {claims.map((claim) => (
                <ClaimStub
                  key={claim.id}
                  claim={claim}
                  onPress={() => router.push(ROUTES.INSURANCE.CLAIM(claim.id))}
                />
              ))}
            </View>
          </View>
        ) : null}

        <TermsPanel
          exclusions={policy.exclusions}
          disclaimer={policy.nonAdviceDisclaimer}
          insurerNotice={policy.insurerNotice}
        />

        {/* ── cancel ───────────────────────────────────────────────────────── */}
        {canCancel ? (
          <View style={styles.section}>
            <Rule />
            <Button
              label={
                policy.canCancelForFullRefund
                  ? 'Cancel and refund my premium'
                  : 'Cancel this cover'
              }
              onPress={onCancel}
              variant="destructive"
              disabled={busy}
            />
            <Micro tone="faint" center>
              {policy.canCancelForFullRefund
                ? `Free-look window closes ${relativeDays(policy.freeLookEndsAt)} — until then you get every rupee back.`
                : 'The free-look window has closed, so cancelling ends cover without a refund.'}
            </Micro>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/** One labelled fact, full-bleed inside a padless panel. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Legend small tone="faint">
        {label}
      </Legend>
      <Text role="bodySm" style={styles.rowValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  section: { gap: Space.md },
  list: { gap: Space.sm },
  block: { gap: Space.md },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  blockTitle: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.lg,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
  },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
