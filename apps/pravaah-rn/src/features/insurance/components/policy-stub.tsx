import { StyleSheet, View } from 'react-native';

import type { Claim, Policy } from '@/api/insurance/schemas';
import { Icon, Legend, Micro, Press, Text } from '@/components/ui';
import { Hairline, Radius, Space, toneColor, usePalette } from '@/theme';
import {
  CLAIM_META,
  frequencySuffix,
  policyDate,
  POLICY_META,
  PRODUCT_META,
  relativeDays,
} from '@/features/insurance/insurance-meta';

/**
 * A policy, as a list row.
 *
 * ## Why a torn stub rather than a card
 *
 * The payments surface established this: a list of held instruments renders as counterfoil
 * stubs with a torn left edge, because a stub is the part you keep when the instrument
 * itself has gone elsewhere. A policy is exactly that — the contract sits with the insurer,
 * the holder keeps the record. Using the same form here means the wallet and the cheque
 * book read as two drawers of one document case rather than two apps.
 *
 * The tear is drawn as a repeated notch on the leading edge, which is also what makes the
 * status tone legible at list density: the perforation carries the colour, so the row does
 * not need a filled pill competing with the policy name.
 */
export function PolicyStub({
  policy,
  onPress,
}: {
  policy: Policy;
  onPress: () => void;
}) {
  const p = usePalette();
  const meta = POLICY_META[policy.status];
  const tone = toneColor(meta.tone, p);
  const product = PRODUCT_META[policy.product.type];

  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.sm}
      accessibilityRole="button"
      accessibilityLabel={`${policy.product.label}, ${meta.label}. Cover left ${policy.remainingCover.formatted}. Policy ${policy.policyNumber}.`}
    >
      <View style={[styles.stub, { backgroundColor: p.panel, borderColor: p.rule }]}>
        {/* The torn edge, carrying the status tone. */}
        <Perforation color={tone.rule} />

        <View style={styles.body}>
          <View style={styles.topRow}>
            <Icon name={product.icon} size={15} color={p.inkDim} weight={1.6} />
            <Text role="bodySmMedium" style={styles.name}>
              {policy.product.label}
            </Text>
            <Legend small tone="inherit" style={{ color: tone.ink }}>
              {meta.label}
            </Legend>
          </View>

          <View style={styles.figures}>
            <View style={styles.figure}>
              <Legend small tone="faint">
                Cover left
              </Legend>
              <Text role="bodyMedium">{policy.remainingCover.formatted}</Text>
            </View>
            <View style={styles.figure}>
              <Legend small tone="faint">
                Premium
              </Legend>
              <Text role="bodySm" tone="dim">
                {policy.premium.formatted}
                {frequencySuffix(policy.frequency)}
              </Text>
            </View>
          </View>

          {/*
            The one line that changes per state.

            A waiting-period countdown, a grace deadline, a next-premium date, or the term
            end — whichever is the thing the holder needs to know about THIS policy right
            now. One line rather than four, because a stub that showed every date would be
            a certificate.
          */}
          <View style={styles.footRow}>
            <Micro tone="dim">{stubLine(policy)}</Micro>
            <Text role="serial" tone="faint" style={styles.serial}>
              {policy.policyNumber}
            </Text>
          </View>
        </View>
      </View>
    </Press>
  );
}

/** The single most useful date for a policy in this state. */
function stubLine(policy: Policy): string {
  if (policy.status === 'PENDING_PAYMENT') {
    return 'awaiting the first premium';
  }
  if (policy.isInWaitingPeriod) {
    return `covered from ${policyDate(policy.waitingPeriodEndsAt)}`;
  }
  if (policy.status === 'GRACE' && policy.graceEndsAt) {
    return `premium overdue · grace ends ${relativeDays(policy.graceEndsAt)}`;
  }
  if (policy.status === 'ACTIVE' && policy.nextPremiumDueAt) {
    return `next premium ${relativeDays(policy.nextPremiumDueAt)}`;
  }
  if (policy.status === 'ACTIVE' && policy.endAt) {
    return `cover until ${policyDate(policy.endAt)}`;
  }
  return POLICY_META[policy.status].label.toLowerCase();
}

/**
 * A claim, as a list row.
 *
 * Same stub form as a policy, because a claim is the other half of the same document
 * case — and because the tone rules differ in one important way that a shared form makes
 * obvious: an APPROVED claim is GOLD, not green. The claimant has been promised money
 * that has not arrived, and a cleared seal on it would show a settled payout they cannot
 * spend. Only `PAID` earns the field tone.
 */
export function ClaimStub({
  claim,
  onPress,
}: {
  claim: Claim;
  onPress: () => void;
}) {
  const p = usePalette();
  const meta = CLAIM_META[claim.status];
  const tone = toneColor(meta.tone, p);

  return (
    <Press
      onPress={onPress}
      depth="subtle"
      radius={Radius.sm}
      accessibilityRole="button"
      accessibilityLabel={`Claim ${claim.claimNumber} for ${claim.amountClaimed.formatted}. ${meta.label}.`}
    >
      <View style={[styles.stub, { backgroundColor: p.panel, borderColor: p.rule }]}>
        <Perforation color={tone.rule} />

        <View style={styles.body}>
          <View style={styles.topRow}>
            <Icon name={meta.icon} size={15} color={tone.ink} weight={1.6} />
            <Text role="bodySmMedium" style={styles.name}>
              {meta.label}
            </Text>
            <Text role="bodyMedium">
              {/*
                The APPROVED amount once there is one, otherwise what was asked for.

                A partially approved claim must not keep showing the claimed figure — the
                claimant would read the smaller payout as an error rather than as the
                decision it was, and the reason is on the detail screen.
              */}
              {(claim.amountApproved ?? claim.amountClaimed).formatted}
            </Text>
          </View>

          <View style={styles.footRow}>
            <Micro tone="dim">{claimStubLine(claim)}</Micro>
            <Text role="serial" tone="faint" style={styles.serial}>
              {claim.claimNumber}
            </Text>
          </View>
        </View>
      </View>
    </Press>
  );
}

function claimStubLine(claim: Claim): string {
  if (claim.status === 'SUBMITTED') {
    const count = claim.documents.length;
    return count === 0
      ? 'no documents yet — tap to add'
      : `${count} document${count === 1 ? '' : 's'} · not yet submitted`;
  }
  if (claim.status === 'INFO_REQUESTED') return 'waiting on you';
  if (claim.status === 'PAID' && claim.paidAt) {
    return `paid ${policyDate(claim.paidAt)}`;
  }
  if (claim.status === 'APPROVED') return 'payout on its way';
  if (claim.decidedAt) return `decided ${policyDate(claim.decidedAt)}`;
  return `filed ${policyDate(claim.submittedAt)}`;
}

/**
 * The torn leading edge.
 *
 * Six notches drawn as a column of half-circles in the ground colour, so the edge reads
 * as removed paper rather than as a decorative border. Cheaper than an SVG mask and it
 * survives both themes, because the notches take the SHEET's colour rather than a fixed
 * one — on the field-coloured panel of dark mode they still read as holes.
 */
function Perforation({ color }: { color: string }) {
  const p = usePalette();
  return (
    <View style={[styles.perf, { borderRightColor: color }]}>
      {Array.from({ length: 6 }).map((_, index) => (
        <View
          key={index}
          style={[styles.notch, { backgroundColor: p.ground }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stub: {
    flexDirection: 'row',
    borderWidth: Hairline.base,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  perf: {
    width: 7,
    borderRightWidth: Hairline.thick,
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingVertical: Space.xs,
  },
  notch: { width: 5, height: 5, borderRadius: 3 },
  body: { flex: 1, padding: Space.lg, gap: Space.sm },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  name: { flex: 1 },
  figures: { flexDirection: 'row', gap: Space.xxl },
  figure: { gap: 2 },
  footRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
  serial: { fontSize: 10 },
});
