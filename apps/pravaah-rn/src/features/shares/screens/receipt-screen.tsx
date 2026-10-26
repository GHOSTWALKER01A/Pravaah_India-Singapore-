import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import type { ShareReceiptDetail } from '@/api';
import {
  Button,
  FieldGrid,
  FieldRow,
  Header,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Screen,
  StatusMark,
  Text,
  Thread,
  ThreadStep,
  haptic,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { STATUS_TONE, Space, type StatusTone } from '@/theme';

import { Counterparty } from '../components/counterparty';
import { DisclosureList } from '../components/disclosure-list';
import {
  channelLabel,
  daysUntil,
  decisionLabel,
  formatDate,
  retentionLabel,
} from '../share-meta';
import { useClaimLabels } from '../use-claim-labels';
import { useShareReceipt } from '../use-share-receipt';

/**
 * One consent receipt — the durable record of one share, and the place to withdraw it.
 *
 * Built to answer, in order, the four questions a holder brings to it: who has my data,
 * what exactly did I give them, what did they do with it, and how do I take it back.
 *
 * The withdrawal copy is deliberately precise about its limits. Withdrawing deletes
 * PRAVAAH's copy and obliges the organisation to delete theirs; it cannot recall what they
 * already received or reverse a decision they already made. Promising more than that on
 * the one screen built for trust would spend it.
 */
export function ReceiptScreen({ receiptId }: { receiptId: string }) {
  const {
    receipt,
    loading,
    notFound,
    error,
    refetch,
    withdrawing,
    withdrawError,
    withdraw,
  } = useShareReceipt(receiptId);
  const labelFor = useClaimLabels();
  const [refreshing, setRefreshing] = useState(false);
  const [notified, setNotified] = useState<boolean | null>(null);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  if (loading && !receipt) {
    return (
      <Screen>
        <Header title="Consent receipt" />
        <ListSkeleton rows={5} label="Loading this receipt" />
      </Screen>
    );
  }

  if (notFound || !receipt) {
    return (
      <Screen>
        <Header
          title={notFound ? 'Receipt not found' : 'Consent receipt'}
          lede={
            notFound
              ? 'This receipt does not exist, or it belongs to another account.'
              : undefined
          }
        />
        <View style={styles.sheet}>
          {error ? (
            <Notice tone="error" action="Try again" onAction={() => void refetch()}>
              {error}
            </Notice>
          ) : null}
          <Button
            label="All my shares"
            variant="secondary"
            onPress={() => router.replace(ROUTES.PASSPORT.SHARES)}
          />
        </View>
      </Screen>
    );
  }

  const confirmWithdraw = () => {
    Alert.alert(
      'Withdraw this share?',
      `Pravaah deletes its copy now and tells ${receipt.partner.name} to delete theirs. It cannot unsend what they already received, or undo a decision they already made.`,
      [
        { text: 'Keep sharing', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () =>
            void withdraw().then((result) => {
              if (result) {
                haptic.destroy();
                setNotified(result.partnerNotified);
              } else {
                haptic.refused();
              }
            }),
        },
      ],
    );
  };

  const withheld = receipt.claimsWithheld.map((claim) => ({ claim, label: labelFor(claim) }));

  return (
    <Screen
      onRefresh={onRefresh}
      refreshing={refreshing}
      footer={
        receipt.canWithdraw ? (
          <Button
            label="Withdraw this share"
            variant="destructive"
            icon="revoke"
            loading={withdrawing}
            onPress={confirmWithdraw}
            hint={`Deletes Pravaah’s copy now and tells ${receipt.partner.name} to delete theirs.`}
          />
        ) : undefined
      }
    >
      <Header
        legend="Consent receipt"
        title={receipt.partner.name}
        aside={<StatusMark status={receipt.status} />}
      />

      <View style={styles.sheet}>
        {error ? (
          <Notice tone="error" action="Try again" onAction={() => void refetch()}>
            {error}
          </Notice>
        ) : null}
        {withdrawError ? <Notice tone="error">{withdrawError}</Notice> : null}

        {notified !== null && receipt.status === 'WITHDRAWN' ? (
          <Notice tone="cleared" title="Share withdrawn">
            {notified
              ? `Pravaah has deleted its copy, and ${receipt.partner.name} was notified just now that they must delete theirs.`
              : `Pravaah has deleted its copy. ${receipt.partner.name} will see the withdrawal the next time they check this verification, and must then delete theirs.`}
          </Notice>
        ) : null}

        <Panel>
          <Legend>Who you shared with</Legend>
          <View style={styles.first}>
            <Counterparty
              name={receipt.partner.name}
              domain={receipt.partner.domain}
              type={receipt.partner.type}
              country={receipt.partner.country}
              approved={receipt.partner.stillApproved}
            />
          </View>
          <Text role="bodySm" style={styles.purpose}>
            {receipt.purpose}
          </Text>
        </Panel>

        {receipt.status === 'ACTIVE' && !receipt.partner.stillApproved ? (
          <Notice tone="caution" title="Consider withdrawing">
            Pravaah has suspended or removed this organisation. Withdrawing makes sure your
            data is deleted now rather than when the retention term ends.
          </Notice>
        ) : null}

        <DisclosureList
          shared={receipt.claimsShared}
          questions={receipt.predicatesAnswered}
          withheld={withheld}
        />

        <View style={styles.timeline}>
          <Legend>What happened</Legend>
          <Timeline receipt={receipt} />
        </View>

        <FieldGrid>
          <FieldRow label="Shared" value={formatDate(receipt.issuedAt)} />
          <FieldRow label="How" value={channelLabel(receipt.channel)} />
          <FieldRow label="Retention promised" value={retentionLabel(receipt.retentionDays)} />
          <FieldRow
            label={receipt.dataDeletedAt ? 'Pravaah’s copy deleted' : 'Pravaah deletes its copy'}
            value={formatDate(receipt.dataDeletedAt ?? receipt.deletesOn)}
            tone={receipt.dataDeletedAt ? 'cleared' : 'default'}
          />
          <FieldRow label="Receipt" value={receipt.id.slice(0, 8).toUpperCase()} />
        </FieldGrid>

        <Micro>
          This receipt records the names of what you shared, never the values. Quote the
          receipt number if you ever need to raise a question about this share.
        </Micro>
      </View>
    </Screen>
  );
}

/**
 * The share's life, as the security thread the rest of the app uses for multi-step
 * processes. The last step is AHEAD while the organisation still holds the data — the
 * one open question on an active receipt is when that ends.
 */
function Timeline({ receipt }: { receipt: ShareReceiptDetail }) {
  const steps: {
    key: string;
    tone: StatusTone;
    position: 'done' | 'live' | 'ahead';
    title: string;
    detail: string;
  }[] = [
    {
      key: 'asked',
      tone: 'field',
      position: 'done',
      title: `${receipt.partner.name} asked`,
      detail: formatDate(receipt.requestedAt),
    },
    {
      key: 'shared',
      tone: 'field',
      position: 'done',
      title: 'You approved on this phone',
      detail: `${formatDate(receipt.issuedAt)} · signed by your device, for them alone`,
    },
  ];

  if (receipt.partnerDecision) {
    const decision = decisionLabel(receipt.partnerDecision.decision);
    steps.push({
      key: 'decision',
      tone:
        decision.tone === 'cleared' ? 'field' : decision.tone === 'carmine' ? 'carmine' : 'latent',
      position: 'done',
      title: decision.label,
      detail: formatDate(receipt.partnerDecision.decidedAt),
    });
  }

  if (receipt.status === 'WITHDRAWN') {
    steps.push({
      key: 'end',
      tone: 'neutral',
      position: 'done',
      title: 'You withdrew this share',
      detail: `${formatDate(receipt.withdrawnAt)} · Pravaah’s copy deleted, ${receipt.partner.name} told to delete theirs`,
    });
  } else if (receipt.status === 'EXPIRED') {
    steps.push({
      key: 'end',
      tone: 'neutral',
      position: 'done',
      title: 'Retention term ended',
      detail: `${formatDate(receipt.dataDeletedAt ?? receipt.deletesOn)} · Pravaah’s copy deleted`,
    });
  } else {
    const days = daysUntil(receipt.deletesOn);
    steps.push({
      key: 'end',
      tone: 'latent',
      position: 'ahead',
      title: 'Pravaah deletes its copy',
      detail: `${formatDate(receipt.deletesOn)} · in ${days} ${days === 1 ? 'day' : 'days'}, or sooner if you withdraw`,
    });
  }

  return (
    <Thread>
      {steps.map((step, index) => (
        <ThreadStep
          key={step.key}
          tone={step.tone}
          shape={STATUS_TONE[step.tone]}
          position={step.position}
          last={index === steps.length - 1}
        >
          <Text role="bodySmMedium">{step.title}</Text>
          <Micro tone="dim">{step.detail}</Micro>
        </ThreadStep>
      ))}
    </Thread>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm },
  first: { marginTop: Space.sm },
  purpose: { marginTop: Space.md },
  timeline: { gap: Space.md },
});
