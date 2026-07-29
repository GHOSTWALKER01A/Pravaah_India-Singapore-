import type {
  FraudCaseStatus,
  FraudSeverity,
  RiskDecision,
  RiskSubjectType,
} from '@/lib/api/fraud/fraud.schema';

/**
 * How M6's states read to an analyst.
 *
 * `Record<Union, …>` throughout, never `Record<string, …>` with a fallback — the same rule the
 * payments and insurance badges state, and it earns its keep the same way: adding a state to
 * the backend enum would otherwise leave this file compiling while rendering a raw
 * `SCREAMING_CASE` token on the one screen somebody opens during an incident.
 *
 * ## The tone decisions, and why each is not a preference
 *
 * **`OPEN` is amber, not red.** A non-empty fraud queue is the NORMAL state of a working risk
 * engine; thresholds that never held anything would not be doing their job. Red on every open
 * case would make the colour meaningless by the second day.
 *
 * **`HOLD` is amber and `BLOCK` is red, and the gap between them is the whole ladder.** A hold
 * is a DELAY with a review path — the user's money is in suspense and a human decides. A block
 * refused the action outright. Colouring them alike would lose the distinction the four-band
 * ladder exists to make, and would tell an analyst a recoverable case is a terminal one.
 *
 * **`REVIEW` is grey, like `ALLOW`.** The shadow-review band let the action THROUGH; it is a
 * sampling marker, not an intervention. Tinting it would put a colour on rows where nothing
 * happened, and an analyst scanning for what was stopped would have to read every one.
 *
 * **`CLEARED` is green.** It is the FALSE-POSITIVE outcome, and that is worth marking
 * positively rather than neutrally: a console where clearing a case looks like a non-event is
 * one where analysts drift toward confirming, because only confirming feels like work.
 *
 * **`CONFIRMED_FRAUD` is red but not an alarm.** It is a completed, correct outcome. The alarm
 * tone in this file is reserved for the SLA breach, which is the only state that means somebody
 * is waiting longer than we promised.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Cases
   ──────────────────────────────────────────────────────────────────────────── */

const CASE_TONE: Record<FraudCaseStatus, string> = {
  OPEN: 'text-amber-600 dark:text-amber-400',
  INVESTIGATING: 'text-amber-600 dark:text-amber-400',
  INFO_REQUESTED: 'text-amber-600 dark:text-amber-400',
  CLEARED: 'text-green-600 dark:text-green-400',
  CONFIRMED_FRAUD: 'text-red-600 dark:text-red-400',
  ESCALATED: 'text-violet-600 dark:text-violet-400',
};

/** Plain words. `INFO_REQUESTED` is not a sentence, and `OPEN` says nothing about who acts. */
const CASE_LABEL: Record<FraudCaseStatus, string> = {
  OPEN: 'Unclaimed',
  INVESTIGATING: 'Being worked',
  INFO_REQUESTED: 'Waiting on the customer',
  CLEARED: 'Cleared — false positive',
  CONFIRMED_FRAUD: 'Confirmed fraud',
  ESCALATED: 'Escalated to compliance',
};

export function caseStatusLabel(status: FraudCaseStatus): string {
  return CASE_LABEL[status];
}

export function CaseStatusBadge({
  status,
  className = '',
}: {
  status: FraudCaseStatus;
  className?: string;
}) {
  return (
    <span
      className={`text-xs font-medium ${CASE_TONE[status]} ${className}`}
    >
      {CASE_LABEL[status]}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Severity
   ──────────────────────────────────────────────────────────────────────────── */

const SEVERITY_TONE: Record<FraudSeverity, string> = {
  LOW: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  MEDIUM: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  HIGH: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400',
  CRITICAL: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
};

/**
 * Severity as a FILLED pill, unlike every other badge here.
 *
 * The queue is sorted by it, so it is the field an analyst scans down the left of the table —
 * and a coloured word among other coloured words does not survive that scan. A filled chip
 * does. This is the one place in the console where a pill is the right shape.
 */
export function SeverityBadge({ severity }: { severity: FraudSeverity }) {
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_TONE[severity]}`}
    >
      {severity}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Decisions
   ──────────────────────────────────────────────────────────────────────────── */

const DECISION_TONE: Record<RiskDecision, string> = {
  ALLOW: 'text-zinc-500 dark:text-zinc-400',
  // Allowed AND sampled. Grey, because nothing was stopped. See the note above.
  REVIEW: 'text-zinc-500 dark:text-zinc-400',
  STEP_UP: 'text-sky-600 dark:text-sky-400',
  HOLD: 'text-amber-600 dark:text-amber-400',
  BLOCK: 'text-red-600 dark:text-red-400',
};

const DECISION_LABEL: Record<RiskDecision, string> = {
  ALLOW: 'Allowed',
  REVIEW: 'Allowed · sampled',
  STEP_UP: 'Challenged',
  HOLD: 'Held',
  BLOCK: 'Blocked',
};

export function decisionLabel(decision: RiskDecision): string {
  return DECISION_LABEL[decision];
}

export function DecisionBadge({
  decision,
  className = '',
}: {
  decision: RiskDecision;
  className?: string;
}) {
  return (
    <span className={`text-xs font-medium ${DECISION_TONE[decision]} ${className}`}>
      {DECISION_LABEL[decision]}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Subjects
   ──────────────────────────────────────────────────────────────────────────── */

/** What the decision was ABOUT, in the operator's vocabulary rather than the schema's. */
const SUBJECT_LABEL: Record<RiskSubjectType, string> = {
  TRANSACTION: 'Payment',
  CLAIM: 'Insurance claim',
  LOGIN: 'Sign-in',
  DEVICE_BIND: 'Device registration',
  CONSENT: 'Data sharing',
  PAYOUT: 'Payout',
};

export function subjectLabel(subject: RiskSubjectType): string {
  return SUBJECT_LABEL[subject];
}

/* ────────────────────────────────────────────────────────────────────────────
   Signals
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A signal's contribution to the score, as a bar.
 *
 * `weight × value`, which is the number that actually entered the noisy-OR — NOT the weight
 * alone. Showing the weight would misrepresent a mild geo anomaly and a blatant one as
 * identical contributions, which is precisely the distinction `value` exists to carry.
 *
 * A hard signal renders full-width and red regardless of arithmetic, because it BYPASSED the
 * arithmetic. Drawing it proportionally would imply it was averaged with the rest, and an
 * analyst would be left unable to explain why a 0.02 score produced a BLOCK.
 */
export function SignalBar({
  weight,
  value,
  isHard,
}: {
  weight: number;
  value: number;
  isHard: boolean;
}) {
  const contribution = Math.max(0, Math.min(1, weight * value));
  const width = isHard ? 100 : Math.round(contribution * 100);

  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <span
          className={`block h-full rounded-full ${
            isHard
              ? 'bg-red-500'
              : contribution >= 0.45
                ? 'bg-amber-500'
                : 'bg-sky-500'
          }`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
        {isHard ? 'hard' : contribution.toFixed(2)}
      </span>
    </span>
  );
}

/**
 * The aggregate score, with the band it fell into.
 *
 * The thresholds are duplicated here as DISPLAY constants and nowhere else in this app. The
 * server owns the decision — this only names the band a score sits in, so an analyst can see
 * how close a call was. A case at 0.84 and one at 0.31 are both "allowed" and are not
 * remotely the same situation.
 */
export function ScoreReadout({ score }: { score: number }) {
  const band =
    score >= 0.85
      ? { label: 'hold band', tone: 'text-amber-600 dark:text-amber-400' }
      : score >= 0.55
        ? { label: 'challenge band', tone: 'text-sky-600 dark:text-sky-400' }
        : score >= 0.3
          ? { label: 'watch band', tone: 'text-zinc-500 dark:text-zinc-400' }
          : { label: 'clear', tone: 'text-zinc-500 dark:text-zinc-400' };

  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-mono text-sm font-semibold tabular-nums">
        {score.toFixed(4)}
      </span>
      <span className={`text-[11px] ${band.tone}`}>{band.label}</span>
    </span>
  );
}
