import type { PartnerDecision, PartnerType } from '@/api';

/**
 * M7 vocabulary — the words the holder reads about organisations and what they shared.
 *
 * Pure and dependency-free, like the other `*-meta.ts` files, so the consent screen, the
 * receipt list and the receipt detail cannot drift into three different ways of saying
 * the same thing.
 */

const PARTNER_TYPE_LABEL: Record<PartnerType, string> = {
  LENDER: 'Lender',
  INSURER: 'Insurer',
  EMPLOYER: 'Employer',
  LANDLORD: 'Landlord',
  BANK: 'Bank',
  OTHER: 'Organisation',
};

/** `LENDER` → `Lender`. Unknown types degrade to a neutral word, never a raw token. */
export function partnerTypeLabel(type: string | null | undefined): string {
  return (type && PARTNER_TYPE_LABEL[type as PartnerType]) || 'Organisation';
}

const COUNTRY_NAME: Record<string, string> = {
  IN: 'India',
  SG: 'Singapore',
  INDIA: 'India',
  SINGAPORE: 'Singapore',
};

/** ISO-2 (`SG`) or the credential enum (`SINGAPORE`) → a name a person says. */
export function countryLabel(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_NAME[country.toUpperCase()] ?? country;
}

// ── yes/no answers ──────────────────────────────────────────────────────────
const BAND_LABEL: Record<string, string> = {
  POOR: 'Poor',
  FAIR: 'Fair',
  GOOD: 'Good',
  VERY_GOOD: 'Very good',
  EXCELLENT: 'Excellent',
};

/**
 * Threshold claims are the issuer-signed booleans an organisation's "band ≥ GOOD"
 * question is answered with. Recognised by name so the consent screen can mark them as a
 * yes/no answer — the single most reassuring fact about them is that they reveal neither
 * the score nor the band.
 */
export function isYesNoClaim(claim: string): boolean {
  return claim.startsWith('score_at_least_');
}

/**
 * A predicate key as a question the holder recognises.
 *
 *   `score_band:GTE:GOOD`  → "Is your band Good or better?"
 *
 * The receipt stores the question, not the answer: the holder already knows their own band,
 * and a receipt that repeated it would be one more place it could leak from.
 */
export function predicateQuestion(key: string): string {
  const [claim, op, value] = key.split(':');
  if (claim !== 'score_band' || !op || !value) return 'A yes/no question about your reputation';
  const band = BAND_LABEL[value] ?? value;
  switch (op) {
    case 'GTE':
      return `Is your band ${band} or better?`;
    case 'GT':
      return `Is your band better than ${band}?`;
    case 'LTE':
      return `Is your band ${band} or lower?`;
    case 'LT':
      return `Is your band lower than ${band}?`;
    case 'EQ':
      return `Is your band exactly ${band}?`;
    default:
      return 'A yes/no question about your reputation';
  }
}

// ── outcomes ────────────────────────────────────────────────────────────────
/**
 * The organisation's recorded decision, told to the holder. Worded as what happened to
 * THEM, because "APPROVED" in isolation does not say what was approved.
 */
export function decisionLabel(decision: PartnerDecision): {
  label: string;
  tone: 'cleared' | 'carmine' | 'latent';
} {
  switch (decision) {
    case 'APPROVED':
      return { label: 'They approved your application', tone: 'cleared' };
    case 'DECLINED':
      return { label: 'They declined your application', tone: 'carmine' };
    default:
      return { label: 'Sent to their team for a manual review', tone: 'latent' };
  }
}

export function channelLabel(channel: string): string {
  switch (channel) {
    case 'QR':
      return 'Scanned a code';
    case 'NFC':
      return 'Tapped your card';
    case 'DEEPLINK':
      return 'From a link';
    default:
      return 'Over the internet';
  }
}

// ── time ────────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

/** `12 Sep 2026`. Absolute: a receipt is a record, and "3 days ago" drifts. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Relative for the recent past, absolute once "3 days ago" stops being useful. */
export function formatWhen(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 6) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return formatDate(iso);
}

/** Whole days until `iso`, never negative. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / DAY_MS));
}

/** "30 days" / "1 year" — the retention promise, in the unit a person would use. */
export function retentionLabel(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return `${years} ${years === 1 ? 'year' : 'years'}`;
  }
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "2 details and 1 yes/no answer" — what left the phone, counted honestly. */
export function sharedSummary(claimCount: number, answerCount: number): string {
  const parts: string[] = [];
  const details = claimCount - answerCount;
  if (details > 0) parts.push(`${details} ${details === 1 ? 'detail' : 'details'}`);
  if (answerCount > 0) {
    parts.push(`${answerCount} yes/no ${answerCount === 1 ? 'answer' : 'answers'}`);
  }
  return parts.length ? parts.join(' and ') : 'Only proof of a live passport';
}
