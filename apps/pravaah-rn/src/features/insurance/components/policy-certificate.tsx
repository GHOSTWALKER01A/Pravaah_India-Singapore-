import { StyleSheet, View } from 'react-native';

import type { Policy } from '@/api/insurance/schemas';
import { Field, Icon, Legend, Micro, Rule, Text } from '@/components/ui';
import { Hairline, Radius, Space, toneOnField, usePalette } from '@/theme';
import {
  frequencySuffix,
  policyDate,
  POLICY_META,
  relativeDays,
} from '@/features/insurance/insurance-meta';

/**
 * The policy, as the document it is.
 *
 * ## Why an intaglio certificate rather than a card
 *
 * A policy IS a security document — an indemnity with a number, a term, and a named
 * holder. The world already has the vocabulary for that (the passport is the same object),
 * so a policy renders as a plate with a serial along its base rather than as a consumer
 * card with a coloured status pill. That is not decoration: the visual class tells the
 * holder this is something they can quote to a hospital, which is exactly what a policy
 * number is for.
 *
 * ## The three facts on the plate, and why these three
 *
 *  1. **Whether cover is live.** Not the status name — `GRACE` means nothing to a
 *     policyholder. The seal tone answers "am I covered right now?" before any word is read.
 *  2. **Cover LEFT, not cover bought.** The aggregate limit is what a second claim is
 *     assessed against, and a certificate showing only the sum insured would let somebody
 *     plan a claim against money already paid out.
 *  3. **The waiting-period countdown, while it is running.** The single term
 *     policyholders most misunderstand. Shown as a date AND a day count because the two
 *     answer different questions — "when?" and "how much longer?".
 *
 * ## Why GRACE is gold and not red
 *
 * `POLICY_META` resolves `GRACE` to `latent`. Cover is still LIVE during grace — the
 * premium is late, not void — and a carmine certificate would tell somebody they are
 * uninsured on a day they could still successfully claim. The urgency belongs in the
 * countdown, not in the tone.
 */
export function PolicyCertificate({ policy }: { policy: Policy }) {
  const p = usePalette();
  const meta = POLICY_META[policy.status];
  const ink = toneOnField(meta.tone, p);

  return (
    <Field deep>
      <View style={styles.plate}>
        {/* ── the head: what this is, and whether it is live ────────────────── */}
        <View style={styles.head}>
          <View style={styles.headText}>
            <Legend small tone="inherit" style={{ color: p.onFieldDim }}>
              {policy.product.label}
            </Legend>
            <View style={styles.statusRow}>
              <View style={[styles.seal, { borderColor: ink }]}>
                {policy.isCovered ? (
                  <Icon name="check" size={11} color={ink} weight={2.2} />
                ) : (
                  <Icon name="dash" size={11} color={ink} weight={2.2} />
                )}
              </View>
              <Text role="title" surface="field" tone="inherit" style={{ color: ink }}>
                {policy.isCovered ? 'You are covered' : meta.label}
              </Text>
            </View>
          </View>
          <Icon name="cover" size={26} color={p.onFieldLatent} weight={1.4} />
        </View>

        {/*
          The honest caveat, when there is one.

          `GRACE` and `PENDING_PAYMENT` both read as "covered / not covered" above, which
          is true but incomplete — each needs one sentence about what happens next, and
          burying that in a details screen is how a policy lapses without the holder
          having understood that it could.
        */}
        {policy.status !== 'ACTIVE' ? (
          <View style={[styles.caveat, { borderColor: ink }]}>
            <Text role="bodySm" surface="field" tone="inherit" style={{ color: ink }}>
              {meta.detail}
            </Text>
            {policy.status === 'GRACE' && policy.graceEndsAt ? (
              <Micro tone="inherit" style={{ color: p.onFieldDim }}>
                grace ends {relativeDays(policy.graceEndsAt)} ·{' '}
                {policyDate(policy.graceEndsAt)}
              </Micro>
            ) : null}
          </View>
        ) : null}

        <Rule onField />

        {/* ── cover left, and the premium ───────────────────────────────────── */}
        <View style={styles.grid}>
          <View style={styles.cell}>
            <Legend small tone="inherit" style={{ color: p.onFieldDim }}>
              Cover left
            </Legend>
            <Text role="denominationSm" surface="field">
              {policy.remainingCover.formatted}
            </Text>
            {/*
              Only shown once something has been claimed. On a fresh policy "of ₹20,000"
              beneath ₹20,000 is noise; after a payout it is the most important line here.
            */}
            {policy.claimedToDate.minor !== '0' ? (
              <Micro tone="inherit" style={{ color: p.onFieldDim }}>
                {policy.claimedToDate.formatted} already paid out of{' '}
                {policy.coverage.formatted}
              </Micro>
            ) : (
              <Micro tone="inherit" style={{ color: p.onFieldDim }}>
                sum insured {policy.coverage.formatted}
              </Micro>
            )}
          </View>
        </View>

        <Rule onField />

        <View style={styles.grid}>
          <View style={styles.cell}>
            <Legend small tone="inherit" style={{ color: p.onFieldDim }}>
              Premium
            </Legend>
            <Text role="fieldSm" surface="field">
              {policy.premium.formatted}
              {frequencySuffix(policy.frequency)}
            </Text>
            {policy.nextPremiumDueAt ? (
              <Micro tone="inherit" style={{ color: p.onFieldDim }}>
                next due {relativeDays(policy.nextPremiumDueAt)}
              </Micro>
            ) : null}
          </View>

          <View style={[styles.vrule, { backgroundColor: p.ruleOnField }]} />

          <View style={styles.cell}>
            <Legend small tone="inherit" style={{ color: p.onFieldDim }}>
              {policy.isInWaitingPeriod ? 'Cover starts' : 'Cover until'}
            </Legend>
            <Text role="fieldSm" surface="field">
              {policy.isInWaitingPeriod
                ? policyDate(policy.waitingPeriodEndsAt)
                : policyDate(policy.endAt)}
            </Text>
            {policy.isInWaitingPeriod ? (
              <View style={styles.waitRow}>
                <Icon
                  name="hourglass"
                  size={11}
                  color={p.onFieldLatent}
                  weight={1.7}
                />
                <Micro tone="inherit" style={{ color: p.onFieldLatent }}>
                  {policy.waitingPeriodDaysRemaining}{' '}
                  {policy.waitingPeriodDaysRemaining === 1 ? 'day' : 'days'} to go
                </Micro>
              </View>
            ) : null}
          </View>
        </View>

        {/*
          The serial, along the base. The world's own device.

          The policy number is the string a hospital or an employer will ask for, so it is
          set in mono at the edge of the plate where a serial belongs — readable, quotable,
          and visually distinct from everything that is merely informational.
        */}
        <View style={styles.baseline}>
          <Text role="serial" surface="field" tone="dim">
            {policy.policyNumber}
          </Text>
          {policy.insurerBindPending ? (
            <Micro tone="inherit" style={{ color: p.onFieldDim }}>
              insurer acknowledgement pending
            </Micro>
          ) : null}
        </View>
      </View>
    </Field>
  );
}

const styles = StyleSheet.create({
  plate: { padding: Space.xl, gap: Space.lg },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  headText: { flex: 1, gap: Space.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  seal: {
    width: 20,
    height: 20,
    borderRadius: Radius.pill,
    borderWidth: Hairline.thick,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caveat: {
    borderLeftWidth: Hairline.thick,
    paddingLeft: Space.md,
    gap: Space.xs,
  },
  grid: { flexDirection: 'row', alignItems: 'stretch', gap: Space.lg },
  cell: { flex: 1, gap: Space.xs },
  vrule: { width: Hairline.base, alignSelf: 'stretch' },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  baseline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.sm,
  },
});
