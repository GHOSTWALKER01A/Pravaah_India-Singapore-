/**
 * Every premium period on one policy, and what happened to it.
 *
 * ## Why this screen exists at all
 *
 * It is the document a support call is argued from. A policyholder who believes they paid and
 * whose cover lapsed anyway needs to see each period, its dates, and whether the collection
 * succeeded — and a failed attempt needs to name its reason. Without this the only answer
 * available to them is "our records show", which is not an answer.
 *
 * ## Why a FAILED period is not styled as an error
 *
 * A premium that could not be collected is almost always an empty wallet on the due date, not
 * a fault. Carmine on those rows would read as an accusation across a screen that may be
 * mostly failures for somebody paid irregularly — so a failure takes the latent tone (needs
 * attention) and a REFUNDED one takes neutral, leaving carmine unused here. The tone the
 * world reserves for "the word under pressure" is not earned by a lean month.
 */
import { StyleSheet, View } from 'react-native';

import type { PremiumPayment } from '@/api/insurance/schemas';
import {
  Header,
  Icon,
  Legend,
  ListSkeleton,
  Micro,
  Notice,
  Panel,
  Rule,
  Screen,
  Text,
} from '@/components/ui';
import { Hairline, Radius, Space, usePalette } from '@/theme';

import { policyDate } from '@/features/insurance/insurance-meta';
import { usePremiums } from '@/features/insurance/use-insurance';

/** How a collection outcome reads, and its tone. See the note above on carmine. */
const STATUS: Record<
  string,
  { label: string; tone: 'field' | 'latent' | 'neutral'; icon: 'check' | 'clock' | 'alert' | 'refresh' }
> = {
  PAID: { label: 'Paid', tone: 'field', icon: 'check' },
  PENDING: { label: 'Being collected', tone: 'latent', icon: 'clock' },
  FAILED: { label: 'Could not be collected', tone: 'latent', icon: 'alert' },
  REFUNDED: { label: 'Refunded to you', tone: 'neutral', icon: 'refresh' },
};

export function PremiumsScreen({ policyId }: { policyId: string }) {
  const { premiums, loading, error } = usePremiums(policyId);

  return (
    <Screen>
      <View style={styles.sheet}>
        <Header
          title="Premium history"
          lede="Every period on this policy, and whether it was collected."
        />

        {error ? <Notice tone="error">{error}</Notice> : null}

        {loading ? (
          <ListSkeleton rows={4} label="Loading your premium history" />
        ) : premiums.length === 0 ? (
          <Panel pad="lg">
            <Text role="bodySm" tone="dim" center>
              No premium has been collected on this policy yet.
            </Text>
          </Panel>
        ) : (
          <View style={styles.list}>
            {premiums.map((premium) => (
              <PremiumRow key={premium.id} premium={premium} />
            ))}
          </View>
        )}

        <Micro tone="faint">
          Premiums are taken from your Pravaah wallet. If one cannot be collected your cover
          stays live for a further 7 days while we retry.
        </Micro>
      </View>
    </Screen>
  );
}

function PremiumRow({ premium }: { premium: PremiumPayment }) {
  const p = usePalette();
  const meta = STATUS[premium.status] ?? {
    label: premium.status,
    tone: 'neutral' as const,
    icon: 'clock' as const,
  };

  const ink =
    meta.tone === 'field' ? p.cleared : meta.tone === 'latent' ? p.latent : p.inkDim;

  return (
    <View style={[styles.row, { backgroundColor: p.panel, borderColor: p.rule }]}>
      <View style={[styles.mark, { borderColor: ink }]}>
        <Icon name={meta.icon} size={14} color={ink} weight={1.8} />
      </View>

      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text role="bodySmMedium">{premium.amount.formatted}</Text>
          <Legend small tone="inherit" style={{ color: ink }}>
            {meta.label}
          </Legend>
        </View>

        {/*
          The COVER PERIOD, not the collection date.

          What the money bought. A row showing only "paid on 3 Aug" cannot answer "was I
          covered on the 14th?", which is the only question this screen is ever opened for.
        */}
        <Micro tone="dim">
          Covers {policyDate(premium.periodStart)} – {policyDate(premium.periodEnd)}
        </Micro>

        {premium.status === 'PAID' && premium.paidAt ? (
          <Micro tone="faint">collected {policyDate(premium.paidAt)}</Micro>
        ) : null}

        {premium.failureReason ? (
          <Micro tone="inherit" style={{ color: p.latent }}>
            {premium.failureReason}
          </Micro>
        ) : null}

        {premium.attempt > 1 ? (
          <Micro tone="faint">attempt {premium.attempt}</Micro>
        ) : null}

        {premium.refunded && premium.refunded.minor !== '0' ? (
          <Micro tone="dim">{premium.refunded.formatted} refunded</Micro>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  list: { gap: Space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    padding: Space.lg,
  },
  mark: {
    width: 28,
    height: 28,
    borderRadius: Radius.sm,
    borderWidth: Hairline.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 2 },
  topRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
});
