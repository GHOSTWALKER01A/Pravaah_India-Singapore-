/**
 * Filing a claim.
 *
 * ## Why the coverage facts sit above the form
 *
 * A claim that falls inside the waiting period, outside the term, or above the remaining
 * cover will be refused — and the claimant will experience that refusal as the insurer
 * finding a technicality. So the three numbers that decide it are stated BEFORE the form:
 * what is left to claim, the earliest date that is covered, and the latest. Somebody whose
 * incident falls outside those learns it here, in thirty seconds, instead of in a rejection
 * three days later.
 *
 * ## Why the incident date is typed rather than picked
 *
 * A date picker would be nicer and is not available without a new native dependency. Three
 * numeric fields with an explicit `DD / MM / YYYY` layout are unambiguous in both markets
 * (neither writes month-first), work offline, and — importantly — make a wrong YEAR visible,
 * which is the error that silently pushes an incident outside a policy term.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
  TextField,
} from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space, usePalette } from '@/theme';

import { policyDate } from '@/features/insurance/insurance-meta';
import { usePolicy } from '@/features/insurance/use-insurance';

/** ₹ / S$ amounts are typed in MAJOR units here — see `toMinor` below. */
const MAJOR_DIGITS = /^[0-9]{0,9}$/;

export function FileClaimScreen({ policyId }: { policyId: string }) {
  const router = useRouter();
  const p = usePalette();
  const { policy, loading, error } = usePolicy(policyId);

  const [amount, setAmount] = useState('');
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [description, setDescription] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * When this form was opened, captured once.
   *
   * `Date.now()` inside the validation `useMemo` is an impure call during render, which
   * React Compiler refuses — and rightly: a memo whose result depends on the clock is a memo
   * whose cached value is wrong the moment it is reused. A state initializer runs once, so
   * the clock is read exactly once per mount.
   *
   * A form left open past midnight would then accept "tomorrow" locally. That is fine and
   * deliberate: the SERVER refuses a future incident date, so this check is a courtesy that
   * saves a round trip rather than a control.
   */
  const [openedAt] = useState(() => Date.now());

  /**
   * The typed date as an ISO string, or null while incomplete.
   *
   * Built explicitly with `Date.UTC` rather than parsed from a string, because
   * `new Date('3/8/2026')` is month-first in most engines — which would silently turn
   * "3 August" into "8 March" and move an incident five months, potentially across a
   * waiting-period boundary.
   */
  const incidentIso = useMemo(() => {
    const d = Number(day);
    const m = Number(month);
    const y = Number(year);
    if (!d || !m || year.length !== 4) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;

    const stamp = Date.UTC(y, m - 1, d);
    const date = new Date(stamp);
    // Reject a rolled-over date — 31 February becomes 3 March, which is a real date the
    // claimant did not type and would silently be accepted.
    if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return date.toISOString();
  }, [day, month, year]);

  const amountMinor = useMemo(() => toMinor(amount), [amount]);

  /** Every local check, so the button is honest before the request is made. */
  const problem = useMemo(() => {
    if (!policy) return null;
    if (!amount) return null;
    if (amountMinor === null) return 'Enter the amount in whole rupees.';
    if (amountMinor === '0') return 'The amount has to be more than zero.';
    if (BigInt(amountMinor) > BigInt(policy.remainingCover.minor)) {
      return `This policy has ${policy.remainingCover.formatted} of cover left.`;
    }
    if (incidentIso && new Date(incidentIso).getTime() > openedAt) {
      return 'The incident date cannot be in the future.';
    }
    if (
      incidentIso &&
      policy.waitingPeriodEndsAt &&
      new Date(incidentIso) < new Date(policy.waitingPeriodEndsAt)
    ) {
      return `Incidents before ${policyDate(policy.waitingPeriodEndsAt)} are inside the waiting period and are not covered.`;
    }
    return null;
  }, [policy, amount, amountMinor, incidentIso, openedAt]);

  const ready =
    policy !== null &&
    amountMinor !== null &&
    amountMinor !== '0' &&
    incidentIso !== null &&
    description.trim().length >= 10 &&
    problem === null;

  const onSubmit = async () => {
    if (!policy || !amountMinor || !incidentIso) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const claim = await claimsService.file({
        policyId: policy.id,
        amountClaimedMinor: amountMinor,
        incidentDate: incidentIso,
        description: description.trim(),
      });
      /**
       * Straight to the DOCUMENTS screen, not the claim detail.
       *
       * Nothing is assessed until evidence is attached and the claimant finalises, so
       * landing them on a status screen would show a claim that appears filed and is in
       * fact going nowhere. `replace` because the form is spent — coming back to it would
       * file a duplicate, which the server's dedupe fingerprint would then refuse.
       */
      router.replace(ROUTES.INSURANCE.CLAIM_DOCUMENTS(claim.id));
    } catch (err) {
      /*
        The server's wording, verbatim.

        Its coverage refusals are written for the claimant — "this incident falls inside
        the policy's waiting period, which is not covered" — and replacing that with a
        generic failure would discard the only sentence that explains what happened.
      */
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : 'Could not file this claim. Please try again.',
      );
    } finally {
      setSubmitting(false);
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
          <Header title="Make a claim" />
          <Notice tone="error">{error ?? 'This policy could not be found.'}</Notice>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          label={submitting ? 'Filing…' : 'File this claim'}
          onPress={() => void onSubmit()}
          loading={submitting}
          disabled={!ready}
        />
      }
    >
      <View style={styles.sheet}>
        <Header
          title="Make a claim"
          lede={`${policy.product.label} · ${policy.policyNumber}`}
        />

        {submitError ? <Notice tone="error">{submitError}</Notice> : null}

        {/* ── the three facts that will decide this claim ──────────────────── */}
        <Panel pad="none">
          <Row label="You can claim up to" value={policy.remainingCover.formatted} />
          <Rule />
          <Row
            label="Covered from"
            value={policyDate(policy.waitingPeriodEndsAt ?? policy.startAt)}
          />
          <Rule />
          <Row label="Covered until" value={policyDate(policy.endAt)} />
        </Panel>
        <Micro tone="faint">
          An incident outside those dates is not covered, however genuine it is. Checking
          them now saves you a refusal later.
        </Micro>

        <SectionHead title="What happened" />

        <TextField
          label={`How much are you claiming? (${
            policy.premium.currency === 'INR' ? '₹' : 'S$'
          })`}
          value={amount}
          onChangeText={(next) => {
            if (MAJOR_DIGITS.test(next)) setAmount(next);
          }}
          keyboardType="number-pad"
          placeholder="0"
          // The measured face: an amount is a set value, not prose.
          measured
          hint={`In whole ${
            policy.premium.currency === 'INR' ? 'rupees' : 'dollars'
          }. Claim what you actually lost — your documents have to support it.`}
        />

        <View style={styles.field}>
          <Legend small tone="faint">
            When did it happen?
          </Legend>
          <View style={styles.dateRow}>
            <View style={styles.dateCell}>
              <TextField
                label="Day"
                value={day}
                onChangeText={(next) => setDay(next.replace(/[^0-9]/g, '').slice(0, 2))}
                keyboardType="number-pad"
                placeholder="DD"
                measured
              />
            </View>
            <View style={styles.dateCell}>
              <TextField
                label="Month"
                value={month}
                onChangeText={(next) => setMonth(next.replace(/[^0-9]/g, '').slice(0, 2))}
                keyboardType="number-pad"
                placeholder="MM"
                measured
              />
            </View>
            <View style={styles.yearCell}>
              <TextField
                label="Year"
                value={year}
                onChangeText={(next) => setYear(next.replace(/[^0-9]/g, '').slice(0, 4))}
                keyboardType="number-pad"
                placeholder="YYYY"
                measured
              />
            </View>
          </View>
          {incidentIso ? (
            /*
              The typed date, echoed in words.

              The single most effective guard against a mistyped year, which is the error
              that silently moves an incident outside a policy term.
            */
            <Micro tone="dim">{policyDate(incidentIso)}</Micro>
          ) : (
            <Micro tone="faint">Day, month, year.</Micro>
          )}
        </View>

        <TextField
          label="Tell us what happened"
          value={description}
          onChangeText={setDescription}
          placeholder="I fell at the site on the 20th and could not work for eleven days."
          multiline
          numberOfLines={4}
          hint={
            description.trim().length < 10
              ? 'A sentence or two. A reviewer cannot assess "accident".'
              : 'In your own words. This is what a reviewer reads first.'
          }
        />

        {problem ? <Notice tone="caution">{problem}</Notice> : null}

        <Panel pad="md" tone="sunk" notch={false}>
          <View style={styles.nextRow}>
            <Icon name="document" size={15} color={p.field} weight={1.6} />
            <Micro tone="dim" style={styles.nextText}>
              Next you will add your documents. Nothing is reviewed until you have — filing
              this on its own does not start an assessment.
            </Micro>
          </View>
        </Panel>
      </View>
    </Screen>
  );
}

/**
 * Major units typed by a person → integer minor units.
 *
 * Whole units only, so the conversion is `× 100` with no decimal parsing at all. That is
 * deliberate: a claimant typing `12450.5` on a number pad is far more likely to have
 * fat-fingered a separator than to be claiming half a paisa, and accepting the decimal
 * would make the claim `₹12,450.50` when they meant `₹12,450`. Returns null on anything
 * unparseable so the caller refuses rather than guesses.
 */
function toMinor(major: string): string | null {
  if (major.length === 0) return null;
  if (!/^[0-9]+$/.test(major)) return null;
  return `${BigInt(major) * 100n}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Legend small tone="faint">
        {label}
      </Legend>
      <Text role="bodySmMedium">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: Space.xl, paddingTop: Space.sm, paddingBottom: Space.xxxl },
  field: { gap: Space.sm },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  dateCell: { flex: 1 },
  yearCell: { flex: 1.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Space.lg,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
  },
  nextRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm },
  nextText: { flex: 1 },
});
