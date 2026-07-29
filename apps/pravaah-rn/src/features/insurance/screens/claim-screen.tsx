/**
 * One claim, and where it has got to.
 *
 * ## The one decision this screen turns on
 *
 * A claimant opens this screen to answer "where is my money". So the thread is the first
 * thing on it, `APPROVED` is drawn as still-in-flight rather than complete, and once the
 * payout lands the receipt links straight into the M4 transaction that paid it — because a
 * claim that says "paid" and cannot show the money is indistinguishable from one that lied.
 */
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ApiError } from '@/api';
import { claimsService } from '@/api/insurance/services';
import {
  Button,
  Header,
  Icon,
  Legend,
  Micro,
  Notice,
  Panel,
  PassportSkeleton,
  Rule,
  Screen,
  SectionHead,
  Text,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, toneColor, usePalette } from '@/theme';

import {
  ClaimThread,
  DocumentRow,
} from '@/features/insurance/components';
import { CLAIM_META, policyDate } from '@/features/insurance/insurance-meta';
import { useClaim } from '@/features/insurance/use-claims';

export function ClaimScreen({ claimId }: { claimId: string }) {
  const router = useRouter();
  const p = usePalette();
  const { claim, loading, error, refresh, apply } = useClaim(claimId);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const onWithdraw = () => {
    Alert.alert(
      'Withdraw this claim?',
      'The claim is closed and nothing is paid. You can file a new one if you need to.',
      [
        { text: 'Keep it open', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => void doWithdraw(),
        },
      ],
    );
  };

  const doWithdraw = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await claimsService.withdraw(claimId);
      apply(updated);
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'Could not withdraw this claim.',
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

  if (error || !claim) {
    return (
      <Screen>
        <View style={styles.sheet}>
          <Header title="Your claim" />
          <Notice tone="error">{error ?? 'This claim could not be found.'}</Notice>
        </View>
      </Screen>
    );
  }

  const meta = CLAIM_META[claim.status];
  const tone = toneColor(meta.tone, p);

  const needsDocuments = claim.status === 'SUBMITTED';
  const needsMore = claim.status === 'INFO_REQUESTED';
  const canWithdraw = needsDocuments || needsMore;

  return (
    <Screen
      onRefresh={refresh}
      footer={
        needsDocuments || needsMore ? (
          <Button
            label={
              claim.documents.length === 0
                ? 'Add your documents'
                : needsMore
                  ? 'Add what was asked for'
                  : 'Review and submit'
            }
            onPress={() => router.push(ROUTES.INSURANCE.CLAIM_DOCUMENTS(claim.id))}
            icon="document"
          />
        ) : claim.status === 'PAID' && claim.payoutTransactionId ? (
          <Button
            label="See the payment"
            onPress={() =>
              router.push(ROUTES.PAY.RECEIPT(claim.payoutTransactionId!))
            }
            variant="secondary"
            iconEnd="chevronRight"
          />
        ) : undefined
      }
    >
      <View style={styles.sheet}>
        <Header
          title={meta.label}
          lede={meta.detail}
        />

        {actionError ? <Notice tone="error">{actionError}</Notice> : null}

        {/* ── the amount, and what was actually approved ────────────────────── */}
        <Panel pad="lg" style={styles.amountPanel}>
          <View style={styles.amountRow}>
            <View style={styles.amountCell}>
              <Legend small tone="faint">
                {claim.amountApproved ? 'Approved' : 'You claimed'}
              </Legend>
              <Text
                role="denominationSm"
                tone="inherit"
                style={{ color: claim.amountApproved ? tone.ink : p.ink }}
              >
                {(claim.amountApproved ?? claim.amountClaimed).formatted}
              </Text>
            </View>

            {/*
              The claimed amount, kept visible next to a REDUCED approval.

              A partial approval must not silently replace the figure the claimant asked
              for — they would read the smaller number as an error rather than as a decision,
              and the reason underneath is what makes it arguable.
            */}
            {claim.amountApproved &&
            claim.amountApproved.minor !== claim.amountClaimed.minor ? (
              <View style={styles.amountCell}>
                <Legend small tone="faint">
                  You claimed
                </Legend>
                <Text role="bodyMedium" tone="dim">
                  {claim.amountClaimed.formatted}
                </Text>
              </View>
            ) : null}
          </View>

          <Rule />

          <View style={styles.factRow}>
            <Legend small tone="faint">
              Incident
            </Legend>
            <Text role="bodySm">{policyDate(claim.incidentDate)}</Text>
          </View>
          <View style={styles.factRow}>
            <Legend small tone="faint">
              Claim number
            </Legend>
            <Text role="serial" tone="dim">
              {claim.claimNumber}
            </Text>
          </View>
        </Panel>

        {/* ── the thread ───────────────────────────────────────────────────── */}
        <ClaimThread claim={claim} />

        {/* ── the reviewer's ask, when there is one ────────────────────────── */}
        {needsMore && claim.decisionReason ? (
          <Panel pad="lg" rule={p.latent} style={styles.block}>
            <View style={styles.blockHead}>
              <Icon name="alert" size={17} color={p.latent} weight={1.7} />
              <Text role="bodySmMedium" style={styles.blockTitle}>
                The reviewer needs something from you
              </Text>
            </View>
            <Text role="bodySm">{claim.decisionReason}</Text>
            <Micro tone="faint">
              Nothing moves until you add this. Your claim is not being assessed while it
              waits.
            </Micro>
          </Panel>
        ) : null}

        {/* ── the decision, once there is one ─────────────────────────────── */}
        {claim.decision !== null && claim.status !== 'INFO_REQUESTED' ? (
          <Panel pad="lg" style={styles.block}>
            <Legend small tone="faint">
              The decision
            </Legend>
            {claim.decisionReason ? (
              <Text role="bodySm">{claim.decisionReason}</Text>
            ) : null}
            <Micro tone="faint">
              {claim.decidedBy === 'SYSTEM'
                ? 'Decided automatically — this was a small claim with clear documents. If you disagree, file a new claim and a person will look at it.'
                : 'Decided by a reviewer.'}
              {claim.decidedAt ? ` · ${policyDate(claim.decidedAt)}` : ''}
            </Micro>
          </Panel>
        ) : null}

        {/* ── what was sent in ───────────────────────────────────────────── */}
        {claim.documents.length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="What you sent" />
            <View style={styles.list}>
              {claim.documents.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Micro tone="faint">
            What you wrote: &ldquo;{claim.description}&rdquo;
          </Micro>
        </View>

        {canWithdraw ? (
          <View style={styles.section}>
            <Rule />
            <Button
              label="Withdraw this claim"
              onPress={onWithdraw}
              variant="quiet"
              disabled={busy}
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  section: { gap: Space.md },
  list: { gap: Space.sm },
  amountPanel: { gap: Space.md },
  amountRow: { flexDirection: 'row', gap: Space.xxl },
  amountCell: { gap: Space.xs },
  factRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.lg,
  },
  block: { gap: Space.sm },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  blockTitle: { flex: 1 },
});
