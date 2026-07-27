import type {
  ConsentStatus,
  DataLifeUnit,
  FiType,
} from '@/api/consent/consent.schema';
import type { IconName } from '@/components/ui';

/**
 * The financial-information types a consent can cover.
 *
 * The icons were emoji (🏦 📈 🔁 📊 📉 🧾) and two of them — 📈 for fixed deposits
 * and 📉 for equities — were an up-chart and a down-chart, which read as "fixed
 * deposits are doing well, your equities are losing money". That is a claim about
 * the user's finances made by accident, in the one flow where precision about what
 * is being shared is the entire point.
 */
export const FI_TYPE_META: Record<
  FiType,
  { label: string; description: string; icon: IconName }
> = {
  DEPOSIT: {
    label: 'Bank accounts',
    description: 'Savings and current account statements',
    icon: 'bank',
  },
  TERM_DEPOSIT: {
    label: 'Fixed deposits',
    description: 'Term deposit holdings',
    icon: 'lock',
  },
  RECURRING_DEPOSIT: {
    label: 'Recurring deposits',
    description: 'Monthly deposit commitments',
    icon: 'refresh',
  },
  MUTUAL_FUNDS: {
    label: 'Mutual funds',
    description: 'Fund holdings and their current value',
    icon: 'factors',
  },
  EQUITIES: {
    label: 'Equities',
    description: 'Shares you hold',
    icon: 'dial',
  },
  GSTR: {
    label: 'GST returns',
    description: 'Business turnover and filings',
    icon: 'receipt',
  },
};

export const fiTypeLabel = (t: FiType): string => FI_TYPE_META[t]?.label ?? t;

/** Data-life unit → readable phrase, e.g. "6 months". */
export function dataLifeLabel(unit: DataLifeUnit, value: number): string {
  if (unit === 'INF') return 'Until you revoke it';
  const noun = unit === 'YEAR' ? 'year' : 'month';
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** A consent is a live, working share when ACTIVE. PENDING is mid-approval. */
export const isConsentLive = (s: ConsentStatus): boolean => s === 'ACTIVE';
export const isConsentRevocable = (s: ConsentStatus): boolean =>
  s === 'ACTIVE' || s === 'PAUSED';

/**
 * One line per status, written to answer "so what does that mean for me?".
 * REVOKED and EXPIRED both state that the data is GONE, because that is the fact
 * the user cares about and the status word alone does not say it.
 */
export const CONSENT_STATUS_HINT: Record<ConsentStatus, string> = {
  PENDING: 'Waiting for you to approve it at your Account Aggregator.',
  ACTIVE: 'Live — your data is being used for the purpose stated below.',
  PAUSED: 'Paused. Nothing is being fetched, and nothing has been deleted.',
  REJECTED: 'You declined this request at the Account Aggregator.',
  REVOKED: 'Revoked. Everything fetched under it has been deleted.',
  EXPIRED: 'The retention period ended and the data was deleted.',
  FAILED: 'The request could not be completed. Nothing was shared.',
};

/**
 * The purpose presets.
 *
 * `accent` is gone: it pointed at `Brand.primary` / `Brand.info`, two fixed hexes
 * that gave each preset its own unrelated colour. A consent's colour comes from
 * its STATUS in the note's two-colour system, never from which preset it was.
 */
export interface PurposePreset {
  key: string;
  title: string;
  /** What choosing this actually commits to, in one line. */
  detail: string;
  purpose: string;
  purposeCode: string;
  fiTypes: FiType[];
  fetchType: 'ONETIME' | 'PERIODIC';
}

export const PURPOSE_PRESETS: PurposePreset[] = [
  {
    key: 'score',
    title: 'Score me once',
    detail: 'A single fetch of the last twelve months. Nothing after that.',
    purpose: 'Assess financial reputation for a cross-border credit passport',
    purposeCode: '101',
    fiTypes: ['DEPOSIT', 'GSTR'],
    fetchType: 'ONETIME',
  },
  {
    key: 'monitor',
    title: 'Keep my passport current',
    detail: 'Refreshes monthly while active, so the score never goes stale.',
    purpose: 'Ongoing reputation monitoring for my passport',
    purposeCode: '103',
    fiTypes: ['DEPOSIT'],
    fetchType: 'PERIODIC',
  },
];
