import type {
  ClaimDocStatus,
  ClaimStatus,
  PolicyStatus,
  RiskTier,
} from '@/lib/api/insurance/insurance.schema';

/**
 * How M5's states read to an operator.
 *
 * `Record<Union, …>` throughout, never `Record<string, …>` with a fallback — the same rule
 * `components/payments/status-badge.tsx` states, and it earns its keep the same way: adding a
 * state to the backend enum would otherwise leave this file compiling happily while rendering a
 * raw `SCREAMING_CASE` token on the one screen somebody opens during an incident.
 *
 * ## The tone decisions, and why each is not a preference
 *
 * **`GRACE` is amber, never red, and its label never says "lapsed".** Cover is still LIVE
 * during grace — the premium is late, not void — and a red badge would tell an operator the
 * policy is dead. The action that follows from "dead" is to stop chasing the premium, which is
 * exactly wrong: the seven-day window is when chasing works.
 *
 * **`APPROVED` on a claim is amber, not green.** The claim has been approved and the money has
 * NOT arrived. Green would mark it done on a console whose job includes finding the payouts
 * that never settled. Only `PAID` is green.
 *
 * **`SUSPECT` on a document is amber, not red.** The tamper score is a heuristic — a
 * photocopy, a re-saved scan and a bad thermal printer all score high. Red would tell a
 * reviewer the claim is fraudulent before they have looked, and the whole point of the flag is
 * that a human looks.
 *
 * **`SUBSTANDARD` is amber, `DECLINE` is red.** One was offered cover at a price; the other was
 * not. Colouring them alike would lose the distinction the underwriting engine exists to make.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Claims
   ──────────────────────────────────────────────────────────────────────────── */

const CLAIM_TONE: Record<ClaimStatus, string> = {
  SUBMITTED: 'text-zinc-500 dark:text-zinc-400',
  UNDER_REVIEW: 'text-amber-600 dark:text-amber-400',
  INFO_REQUESTED: 'text-amber-600 dark:text-amber-400',
  // Approved and unpaid. See the note above.
  APPROVED: 'text-amber-600 dark:text-amber-400',
  PAID: 'text-green-600 dark:text-green-400',
  REJECTED: 'text-red-600 dark:text-red-400',
  WITHDRAWN: 'text-zinc-500 dark:text-zinc-400',
};

/** Plain words for an operator. `INFO_REQUESTED` is not a sentence. */
const CLAIM_LABEL: Record<ClaimStatus, string> = {
  SUBMITTED: 'Filed, no evidence yet',
  UNDER_REVIEW: 'Needs a decision',
  INFO_REQUESTED: 'Waiting on the claimant',
  APPROVED: 'Approved — payout pending',
  PAID: 'Paid',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export function claimStatusLabel(status: ClaimStatus): string {
  return CLAIM_LABEL[status];
}

export function ClaimStatusBadge({
  status,
  className = '',
}: {
  status: ClaimStatus;
  className?: string;
}) {
  return (
    <span className={`text-sm ${CLAIM_TONE[status]} ${className}`.trim()}>
      {CLAIM_LABEL[status]}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Policies
   ──────────────────────────────────────────────────────────────────────────── */

const POLICY_TONE: Record<PolicyStatus, string> = {
  PENDING_PAYMENT: 'text-amber-600 dark:text-amber-400',
  ACTIVE: 'text-green-600 dark:text-green-400',
  // Live cover with a late premium. Amber, never red.
  GRACE: 'text-amber-600 dark:text-amber-400',
  LAPSED: 'text-red-600 dark:text-red-400',
  CANCELLED: 'text-zinc-500 dark:text-zinc-400',
  EXPIRED: 'text-zinc-500 dark:text-zinc-400',
};

const POLICY_LABEL: Record<PolicyStatus, string> = {
  PENDING_PAYMENT: 'Awaiting first premium',
  ACTIVE: 'In force',
  GRACE: 'In force · premium overdue',
  LAPSED: 'Lapsed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Term ended',
};

export function policyStatusLabel(status: PolicyStatus): string {
  return POLICY_LABEL[status];
}

export function PolicyStatusBadge({
  status,
  className = '',
}: {
  status: PolicyStatus;
  className?: string;
}) {
  return (
    <span className={`text-sm ${POLICY_TONE[status]} ${className}`.trim()}>
      {POLICY_LABEL[status]}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Documents
   ──────────────────────────────────────────────────────────────────────────── */

const DOC_TONE: Record<ClaimDocStatus, string> = {
  UPLOADED: 'text-zinc-500 dark:text-zinc-400',
  OCR_DONE: 'text-zinc-500 dark:text-zinc-400',
  VERIFIED: 'text-green-600 dark:text-green-400',
  SUSPECT: 'text-amber-700 dark:text-amber-400',
  REJECTED: 'text-red-600 dark:text-red-400',
};

/**
 * The admin wording, which differs from the claimant's on purpose.
 *
 * A claimant sees "a person will check this" for a SUSPECT document — never an accusation on a
 * heuristic. A REVIEWER sees the actual signal, because they are the human the flag exists to
 * summon and they have the context to weigh it.
 */
const DOC_LABEL: Record<ClaimDocStatus, string> = {
  UPLOADED: 'Received',
  OCR_DONE: 'Read',
  VERIFIED: 'Verified',
  SUSPECT: 'Possible alteration',
  REJECTED: 'Unreadable',
};

export function DocStatusBadge({ status }: { status: ClaimDocStatus }) {
  return <span className={`text-xs ${DOC_TONE[status]}`}>{DOC_LABEL[status]}</span>;
}

/* ────────────────────────────────────────────────────────────────────────────
   Underwriting
   ──────────────────────────────────────────────────────────────────────────── */

const TIER_TONE: Record<RiskTier, string> = {
  PREFERRED: 'text-green-600 dark:text-green-400',
  STANDARD: 'text-zinc-600 dark:text-zinc-300',
  SUBSTANDARD: 'text-amber-600 dark:text-amber-400',
  DECLINE: 'text-red-600 dark:text-red-400',
};

const TIER_LABEL: Record<RiskTier, string> = {
  PREFERRED: 'Preferred',
  STANDARD: 'Standard',
  SUBSTANDARD: 'Substandard',
  DECLINE: 'Declined',
};

export function RiskTierBadge({ tier }: { tier: RiskTier }) {
  return <span className={`text-sm ${TIER_TONE[tier]}`}>{TIER_LABEL[tier]}</span>;
}

/* ────────────────────────────────────────────────────────────────────────────
   The fraud score
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The M6 claim risk score, as a band rather than a bare number.
 *
 * `0.34` means nothing to a reviewer on its own. What they need is whether it crossed the
 * threshold that BLOCKED auto-approval — 0.3 — because that is the fact which explains why this
 * claim is on their desk at all. So the number is shown alongside the band, not instead of it.
 *
 * `null` reads as "not scored yet" rather than as zero. A claim still at SUBMITTED has never
 * been through the gate, and rendering that as a perfect 0.00 would tell a reviewer it had been
 * assessed and cleared.
 */
export function RiskScoreBadge({
  score,
  flags = [],
}: {
  score: number | null;
  flags?: string[];
}) {
  if (score === null) {
    return <span className="text-xs text-zinc-400">not scored yet</span>;
  }

  const band =
    score >= 0.6
      ? { label: 'high', tone: 'text-red-600 dark:text-red-400' }
      : score >= 0.3
        ? { label: 'elevated', tone: 'text-amber-600 dark:text-amber-400' }
        : { label: 'low', tone: 'text-green-600 dark:text-green-400' };

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`font-mono text-sm ${band.tone}`}>{score.toFixed(2)}</span>
      <span className={`text-xs ${band.tone}`}>{band.label}</span>
      {flags.length > 0 ? (
        <span className="text-muted-foreground text-xs">
          · {flags.length} signal{flags.length === 1 ? '' : 's'}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The signals the fraud hook actually fired, spelled out.
 *
 * A reviewer cannot weigh `POST_WAITING_WINDOW` — but they can weigh "claimed within days of
 * the waiting period ending", which is the strongest single signal in short-tail
 * micro-insurance. An unrecognised flag falls back to its own name rather than being dropped:
 * a signal the console does not know about is still a signal, and hiding it would silently
 * narrow the evidence a payout rests on.
 */
const FLAG_COPY: Record<string, string> = {
  POST_WAITING_WINDOW:
    'Claimed within days of the waiting period ending — the strongest signal that the loss was already known.',
  FULL_COVER_CLAIM:
    'Claimed at or near the entire sum insured. Genuine losses are rarely exactly the maximum.',
  CLAIM_VELOCITY: 'Several claims from this holder inside a month.',
  AMOUNT_MISMATCH:
    'The document supports materially less than the amount claimed.',
  NEW_POLICY: 'The policy was bought only days before the incident.',
  PRIOR_REJECTION:
    'A previous claim on this policy was rejected. Context, not a disqualification.',
  NO_DOCUMENTS: 'No documents were attached on a product that requires them.',
  TAMPER_SUSPECTED:
    'A document tripped the alteration check. This claim cannot auto-approve.',
};

export function RiskFlagList({ flags }: { flags: string[] }) {
  if (flags.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No fraud signals fired on this claim.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {flags.map((flag) => (
        <li key={flag} className="flex gap-2 text-xs">
          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500" />
          <span>
            {FLAG_COPY[flag] ?? (
              <span className="font-mono">{flag}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
