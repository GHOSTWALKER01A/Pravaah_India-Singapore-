import type {
  ClaimStatus,
  InsuranceProductType,
  PolicyStatus,
  PremiumFrequency,
  RiskTier,
} from '@/api/insurance/schemas';
import type { IconName } from '@/components/ui';
import type { StatusTone } from '@/theme';

/**
 * How M5's states read to the person holding the policy.
 *
 * `Record<Union, …>` throughout, never `Record<string, …>` with a fallback. That is the
 * same rule the payments meta states and it matters more here: adding a claim status on
 * the backend and rendering `INFO_REQUESTED` raw would leave a claimant staring at a
 * token where the sentence "we need one more document from you" should be — and they
 * would not know they were the one holding the claim up.
 *
 * ## The tone decisions, and why each is not a preference
 *
 * **`GRACE` is latent (gold), never carmine.** A missed premium is late, not void. Cover
 * is still LIVE during grace, and styling it as a failure would tell somebody they are
 * uninsured on a day they could still claim.
 *
 * **`PENDING_PAYMENT` is latent, not neutral.** It is the one policy state that needs an
 * action from the holder, and a grey "pending" reads as something the system is doing.
 *
 * **`APPROVED` on a claim is latent, not field.** The claim has been approved and the
 * money has NOT arrived. Marking it cleared would show a settled seal on a payout the
 * claimant cannot spend yet — the same reason M4 refuses to render a receipt at PENDING.
 *
 * **`SUBSTANDARD` is latent, not carmine.** The applicant was OFFERED cover. Colouring
 * it like a refusal would turn the product's honest answer — "priced higher, here is
 * why, here is what changes it" — into the rejection they get everywhere else.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Products
   ──────────────────────────────────────────────────────────────────────────── */

export const PRODUCT_META: Record<
  InsuranceProductType,
  { icon: IconName; short: string }
> = {
  INCOME_PROTECTION: { icon: 'cover', short: 'Income' },
  HEALTH_TOPUP: { icon: 'faceMatch', short: 'Health' },
  TRAVEL_ACCIDENT: { icon: 'corridor', short: 'Travel' },
};

/**
 * How a premium is described in running text.
 *
 * "/mo" rather than "per month" because it sits beside a denomination in Bodoni at 34pt,
 * where a three-word suffix competes with the figure it qualifies.
 */
export function frequencySuffix(frequency: PremiumFrequency): string {
  return frequency === 'MONTHLY' ? '/mo' : ' once';
}

export function frequencyLabel(frequency: PremiumFrequency): string {
  return frequency === 'MONTHLY' ? 'Every month' : 'One payment';
}

/* ────────────────────────────────────────────────────────────────────────────
   Underwriting
   ──────────────────────────────────────────────────────────────────────────── */

export const TIER_META: Record<
  RiskTier,
  { tone: StatusTone; label: string }
> = {
  PREFERRED: { tone: 'field', label: 'Preferred rate' },
  STANDARD: { tone: 'field', label: 'Standard rate' },
  SUBSTANDARD: { tone: 'latent', label: 'Higher rate' },
  DECLINE: { tone: 'carmine', label: 'Not available yet' },
};

/* ────────────────────────────────────────────────────────────────────────────
   Policy
   ──────────────────────────────────────────────────────────────────────────── */

export const POLICY_META: Record<
  PolicyStatus,
  { tone: StatusTone; label: string; detail: string }
> = {
  PENDING_PAYMENT: {
    tone: 'latent',
    label: 'Awaiting premium',
    detail:
      'Your cover starts once the first premium is collected. Add money to your wallet and try again.',
  },
  ACTIVE: {
    tone: 'field',
    label: 'Active',
    detail: 'You are covered under this policy.',
  },
  GRACE: {
    tone: 'latent',
    label: 'Premium overdue',
    detail:
      'You are still covered, but a premium is late. Pay it before the grace period ends to keep the policy.',
  },
  LAPSED: {
    tone: 'carmine',
    label: 'Lapsed',
    detail:
      'Cover ended because a premium was not paid. You can buy again, but the waiting period starts over.',
  },
  CANCELLED: {
    tone: 'neutral',
    label: 'Cancelled',
    detail: 'You cancelled this policy.',
  },
  EXPIRED: {
    tone: 'neutral',
    label: 'Term ended',
    detail: 'This policy ran its full term.',
  },
};

/* ────────────────────────────────────────────────────────────────────────────
   Claim
   ──────────────────────────────────────────────────────────────────────────── */

export const CLAIM_META: Record<
  ClaimStatus,
  { tone: StatusTone; label: string; detail: string; icon: IconName }
> = {
  SUBMITTED: {
    tone: 'latent',
    label: 'Filed',
    detail:
      'Add your documents, then submit for review. Nothing is assessed until you do.',
    icon: 'claim',
  },
  UNDER_REVIEW: {
    tone: 'latent',
    label: 'Under review',
    detail: 'A reviewer is looking at your claim and the documents you sent.',
    icon: 'clock',
  },
  INFO_REQUESTED: {
    tone: 'latent',
    label: 'More needed from you',
    detail:
      'The reviewer has asked for something specific. Your claim is waiting on you, not on us.',
    icon: 'alert',
  },
  APPROVED: {
    tone: 'latent',
    label: 'Approved — paying out',
    detail:
      'Your claim was approved. The payout is being credited to your Pravaah wallet.',
    icon: 'check',
  },
  PAID: {
    tone: 'field',
    label: 'Paid',
    detail: 'The money is in your Pravaah wallet.',
    icon: 'check',
  },
  REJECTED: {
    tone: 'carmine',
    label: 'Not paid',
    detail:
      'This claim was not approved. The reason is below — you can file a new claim if it was a mistake.',
    icon: 'cross',
  },
  WITHDRAWN: {
    tone: 'neutral',
    label: 'Withdrawn',
    detail: 'You withdrew this claim.',
    icon: 'dash',
  },
};

/**
 * The claim's journey, in order, for the progress thread.
 *
 * `PAID` is the terminus rather than `APPROVED`, because the claimant's question is
 * "where is my money", not "what did the reviewer decide". `REJECTED` and `WITHDRAWN`
 * leave the thread rather than sitting on it — they are exits, and drawing them as a
 * fourth step would imply every claim passes through them.
 */
export const CLAIM_JOURNEY: readonly {
  status: ClaimStatus;
  label: string;
}[] = [
  { status: 'SUBMITTED', label: 'Filed' },
  { status: 'UNDER_REVIEW', label: 'Reviewed' },
  { status: 'APPROVED', label: 'Approved' },
  { status: 'PAID', label: 'Paid' },
];

/** How far along the journey a status sits. `-1` for an exit state. */
export function journeyIndex(status: ClaimStatus): number {
  // INFO_REQUESTED is a hold at the review step, not a step of its own: the claim has
  // not moved backwards, it is waiting for the claimant inside review.
  if (status === 'INFO_REQUESTED') return 1;
  return CLAIM_JOURNEY.findIndex((step) => step.status === status);
}

/* ────────────────────────────────────────────────────────────────────────────
   Documents
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * What each document kind is called, and what to actually photograph.
 *
 * The hint is the load-bearing half. "Payslip" to a daily-wage worker paid in cash is a
 * document that does not exist, so the hint names the alternatives an employer letter or
 * a muster-roll entry — that a reviewer will accept. A document list that assumes salaried
 * employment would fail exactly the population this cover is for.
 */
export const DOC_META: Record<string, { label: string; hint: string }> = {
  PAYSLIP: {
    label: 'Proof your income stopped',
    hint:
      'A payslip if you have one — otherwise a letter from your employer or contractor, or a photo of the muster roll showing the days you did not work.',
  },
  MEDICAL_BILL: {
    label: 'Hospital or clinic bill',
    hint: 'The itemised bill showing the total. Photograph the whole page.',
  },
  DISCHARGE_SUMMARY: {
    label: 'Discharge summary',
    hint: 'The sheet the hospital gave you when you left, showing the dates.',
  },
  POLICE_FIR: {
    label: 'Police report (FIR)',
    hint: 'The stamped first page, with the FIR number visible.',
  },
  BOARDING_PASS: {
    label: 'Travel document',
    hint: 'Your boarding pass or ticket for the trip.',
  },
  OTHER: {
    label: 'Something else',
    hint: 'Anything the reviewer asked you for by name.',
  },
};

export function docMeta(docType: string): { label: string; hint: string } {
  return (
    DOC_META[docType] ?? {
      label: docType.replace(/_/g, ' ').toLowerCase(),
      hint: 'Photograph the whole document.',
    }
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Dates
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A date, as a policyholder would read it aloud: `27 Aug 2026`.
 *
 * Day-first because both markets this serves write it that way, and because the
 * ambiguous middle-endian form is a real hazard on a document where "was I covered on
 * 03/08?" decides whether a claim pays.
 */
export function policyDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Whole days from now until `iso`. Negative once it has passed. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - Date.now()) / 86_400_000);
}

/** `in 12 days` / `today` / `4 days ago`. For a due date or a countdown. */
export function relativeDays(iso: string | null): string {
  const days = daysUntil(iso);
  if (days === null) return '—';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}
