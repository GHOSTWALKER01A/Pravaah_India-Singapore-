import type { ScoreBand } from '@/api';
import type { IconName } from '@/components/ui';

/**
 * Band presentation — labels and plain-English blurbs.
 *
 * The COLOUR deliberately does not live here any more. It was a fixed hex per
 * band, which meant the score was the one part of the app that could not respond
 * to the theme: `POOR` stayed `#DC2626` on a dark ground where it fails contrast.
 * Band inks now come from `BAND_INK` via `useBand()`, are verified in both themes,
 * and run as a ramp toward the intaglio field rather than red-to-green — because
 * a FAIR score is a starting point, not a rejection, and the old palette styled it
 * like one.
 */
export const SCORE_BAND_META: Record<ScoreBand, { label: string; blurb: string }> = {
  POOR: {
    label: 'Poor',
    blurb: 'There is real room to grow, and the steps below are the fastest route.',
  },
  FAIR: {
    label: 'Fair',
    blurb: 'A workable starting point. Steady, consistent activity lifts this.',
  },
  GOOD: {
    label: 'Good',
    blurb: 'A solid record. Most lenders will read this as dependable.',
  },
  VERY_GOOD: {
    label: 'Very good',
    blurb: 'A strong record, built on consistent behaviour over time.',
  },
  EXCELLENT: {
    label: 'Excellent',
    blurb: 'Among the strongest profiles — consistency over a long period.',
  },
};

export const SCORE_MIN = 300;
export const SCORE_MAX = 900;

export function bandMeta(band: ScoreBand | null) {
  return band ? SCORE_BAND_META[band] : { label: '—', blurb: '' };
}

/** Where a score sits on the 300–900 axis, as 0..1. */
export function scoreFraction(value: number): number {
  return Math.max(0, Math.min(1, (value - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)));
}

/**
 * Copy for each non-score state.
 *
 * The distinction is load-bearing: each one leads somewhere different, and
 * collapsing them into "no score yet" would strand the user with no next step.
 * That reasoning is the incumbent's and it was correct — what changed is that the
 * emoji (🔓 📭 ⏳ 🕓 ⚠️) are now engraved glyphs, and each entry says what the
 * state MEANS rather than only naming it.
 */
export const SCORE_STATE_META: Record<
  string,
  { icon: IconName; title: string; body: string; cta: string | null }
> = {
  NO_CONSENT: {
    icon: 'consent',
    title: 'Nothing to score yet',
    body: 'A score is built from your real financial history. Share it through the Account Aggregator — no bank password, and revocable at any moment.',
    cta: 'Share my data',
  },
  INSUFFICIENT_DATA: {
    icon: 'receipt',
    title: 'Not enough history yet',
    body: 'There is not enough activity to say anything useful about you. We would rather tell you that than invent a number.',
    cta: 'Link another account',
  },
  PENDING: {
    icon: 'clock',
    title: 'Working out your score',
    body: 'Your statements are being turned into the inputs the model reads. This usually takes under a minute.',
    cta: null,
  },
  EXPIRED: {
    icon: 'history',
    title: 'This score has expired',
    body: 'The consent behind it reached the end of its agreed life and the data was deleted. Sharing again rebuilds the score.',
    cta: 'Share again',
  },
  FAILED: {
    icon: 'alert',
    title: 'Scoring is temporarily unavailable',
    body: 'Something went wrong on our side, not yours. Nothing about your data or your verification has changed.',
    cta: 'Try again',
  },
};

/**
 * Relative bar width for a factor, scaled against the largest driver in the set.
 *
 * Contributions live in the model's log-odds space, so the absolute number is
 * meaningless to a person — only the RELATIVE size carries meaning, and printing
 * the raw figure would invite comparison against points, which it is not.
 */
export function factorWeight(
  contribution: number,
  factors: readonly { contribution: number }[],
): number {
  const largest = Math.max(...factors.map((f) => Math.abs(f.contribution)), 1e-6);
  return Math.max(0.08, Math.abs(contribution) / largest);
}

export function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}
