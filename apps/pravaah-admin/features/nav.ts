import {
  ArrowLeftRight,
  BadgeCheck,
  BookOpenCheck,
  FileCheck2,
  Gauge,
  GitCompareArrows,
  HeartHandshake,
  IdCard,
  KeyRound,
  LayoutDashboard,
  ListX,
  MessageSquareWarning,
  Package,
  ScanEye,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  Siren,
  TrendingUp,
  Umbrella,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import { ROUTES } from '@/features/routes';

/**
 * The console's navigation tree — one declaration, three presentations.
 *
 * The drawer renders this expanded (labels), collapsed (one icon per GROUP, with the
 * group's items in a flyout), and as a mobile overlay. Adding a section is an edit to
 * this file and nothing else; no component knows how many groups there are.
 *
 * GROUPING follows the M0–M7 module map the product is built and discussed in, so the
 * console maps 1:1 onto the build plan and a new module appends as a new group instead
 * of forcing the whole information architecture to be re-thought. The previous flat
 * list had already outgrown itself: eleven peers with the grouping written in source
 * COMMENTS rather than expressed in the UI, which is the reliable signal that the
 * hierarchy belongs on screen.
 *
 * ORDERING within the file is the order an operator works in: the front page, then the
 * queues that gate a person joining (identity), then the machinery that decides what
 * they are worth (reputation, passport), then money — which is last in the lifecycle
 * and first in consequence, and therefore the group that carries alarms.
 */

// ── badges ──────────────────────────────────────────────────────────────────
/**
 * Which live counter feeds a row's badge.
 *
 * A count is the difference between a nav that lists destinations and a nav that tells
 * an operator where the work is. These names are resolved by the shell (see
 * `use-nav-signals.ts`) rather than fetched here, so this file stays pure data and can
 * be imported by anything — including code with no React Query provider above it.
 */
export type NavSignal =
  | 'kycOpen'
  | 'paymentsNeedAttention'
  | 'openMismatches'
  | 'openDisputes'
  /** Claims sitting at UNDER_REVIEW. A queue with people waiting on it. */
  | 'claimsAwaitingReview'
  /**
   * Approved claims whose payout never settled.
   *
   * An `alarm`, not a notice, and it is the single most important counter in this file. Every
   * row is a person who has been TOLD their claim is approved and has not been paid — the
   * quietest failure in the product, because nothing errored and nobody is looking.
   */
  | 'unpaidClaims'
  /**
   * Open fraud cases. Every one is a person whose action is stopped.
   *
   * A `notice` rather than an alarm, because a non-empty fraud queue is the NORMAL state of a
   * working risk engine — thresholds that never held anything would not be doing their job.
   * The alarm is the next entry.
   */
  | 'openFraudCases'
  /**
   * Fraud cases past their SLA.
   *
   * An `alarm`, and it belongs in the same tier as `unpaidClaims` for the same reason: every
   * row is a named person who has been told to wait and has waited longer than we promised.
   * The difference is that this one has their money in suspense while they wait.
   */
  | 'fraudSlaBreached';

/**
 * `alarm` is reserved for a number that means money or a person is stuck and a human
 * has to act. `notice` is a queue that is merely non-empty. Everything else gets no
 * badge at all — a count nobody acts on is noise competing with the ones that matter.
 */
export type NavBadgeTone = 'alarm' | 'notice';

export type NavSignalValues = Partial<Record<NavSignal, number>>;

// ── tree ────────────────────────────────────────────────────────────────────
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Extra words the drawer's filter matches on. These are the terms an operator
   * actually types — the vocabulary of the job, not of our route table. Someone
   * hunting the reconciliation screen types "mismatch" or "trial balance" far more
   * often than they type "reconciliation".
   */
  keywords?: readonly string[];
  signal?: NavSignal;
  signalTone?: NavBadgeTone;
}

export interface NavGroup {
  id: string;
  label: string;
  /** The module in the M0–M7 build plan, shown as a micro-tag on the group header. */
  module: string;
  icon: LucideIcon;
  items: readonly NavItem[];
}

/**
 * The front page, deliberately OUTSIDE the groups.
 *
 * It is a peer of the groups, not a member of one, and pinning it above them keeps the
 * one destination an operator returns to constantly from being hidden behind a
 * disclosure they may have collapsed.
 */
export const NAV_ROOT: NavItem = {
  label: 'Overview',
  href: ROUTES.DASHBOARD.ROOT,
  icon: LayoutDashboard,
  keywords: ['home', 'dashboard', 'start', 'trial balance', 'drift'],
};

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'identity',
    label: 'Identity',
    module: 'M0–M1',
    icon: ShieldCheck,
    items: [
      {
        label: 'KYC Review',
        href: ROUTES.DASHBOARD.KYC,
        icon: FileCheck2,
        keywords: ['onboarding', 'cases', 'queue', 'aadhaar', 'pan', 'singpass'],
        signal: 'kycOpen',
        signalTone: 'notice',
      },
      {
        label: 'Consents',
        href: ROUTES.DASHBOARD.CONSENT,
        icon: ScrollText,
        keywords: ['account aggregator', 'aa', 'data sharing', 'revoke'],
      },
    ],
  },
  {
    id: 'reputation',
    label: 'Reputation',
    module: 'M2',
    icon: Gauge,
    items: [
      {
        label: 'Models & Fairness',
        href: ROUTES.DASHBOARD.MODELS,
        icon: Scale,
        keywords: ['registry', 'version', 'bias', 'drift', 'audit'],
      },
      {
        label: 'Issued Scores',
        href: ROUTES.DASHBOARD.SCORES,
        icon: TrendingUp,
        keywords: ['band', 'explanation', 'override', 'reasons'],
      },
    ],
  },
  {
    id: 'passport',
    label: 'Passport',
    module: 'M3',
    icon: BadgeCheck,
    items: [
      {
        label: 'Credentials',
        href: ROUTES.DASHBOARD.PASSPORTS,
        icon: IdCard,
        keywords: ['passport', 'vc', 'sd-jwt', 'revoke', 'suspend'],
      },
      {
        label: 'Issuer Keys',
        href: ROUTES.DASHBOARD.ISSUER_KEYS,
        icon: KeyRound,
        keywords: ['did', 'jwks', 'rotation', 'trust anchor', 'signing'],
      },
      {
        label: 'Verifiers',
        href: ROUTES.DASHBOARD.VERIFIERS,
        icon: Users,
        keywords: ['partners', 'api key', 'audience', 'lenders'],
      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    module: 'M4',
    icon: Wallet,
    items: [
      {
        label: 'Transactions',
        href: ROUTES.DASHBOARD.PAYMENTS,
        icon: ArrowLeftRight,
        keywords: ['payments', 'upi', 'paynow', 'ledger', 'transfers', 'held'],
        signal: 'paymentsNeedAttention',
        signalTone: 'alarm',
      },
      {
        label: 'Reconciliation',
        href: ROUTES.DASHBOARD.RECONCILIATION,
        icon: GitCompareArrows,
        keywords: ['mismatch', 'rail', 'trial balance', 'settlement', 'deemed'],
        signal: 'openMismatches',
        signalTone: 'alarm',
      },
      {
        label: 'Disputes',
        href: ROUTES.DASHBOARD.PAYMENT_DISPUTES,
        icon: MessageSquareWarning,
        keywords: ['udir', 'complaint', 'chargeback', 'refund', 'sla'],
        signal: 'openDisputes',
        signalTone: 'notice',
      },
    ],
  },
  /**
   * M5 sits AFTER money, which is where it belongs in both the lifecycle and the consequence
   * ordering this file follows: insurance is priced from the reputation the earlier groups
   * built, and its premiums and payouts move over the same ledger the Money group oversees.
   *
   * Four items rather than one, because they answer four different questions. "The Book"
   * leads for the same reason Transactions leads its group — it is the only entry here whose
   * number can be an ALARM (a loss ratio over 100%) rather than a metric.
   */
  {
    id: 'insurance',
    label: 'Insurance',
    module: 'M5',
    icon: Umbrella,
    items: [
      {
        label: 'The Book',
        href: ROUTES.DASHBOARD.INSURANCE,
        icon: BookOpenCheck,
        keywords: [
          'loss ratio',
          'underwriting',
          'float',
          'premium',
          'earned',
          'funnel',
          'decline rate',
          'surplus',
          'deficit',
        ],
        // An unpaid approved claim is money owed to a named person. That is an alarm.
        signal: 'unpaidClaims',
        signalTone: 'alarm',
      },
      {
        label: 'Claims',
        href: ROUTES.DASHBOARD.INSURANCE_CLAIMS,
        icon: HeartHandshake,
        keywords: [
          'adjudicate',
          'approve',
          'reject',
          'payout',
          'fraud',
          'tamper',
          'ocr',
          'documents',
          'queue',
        ],
        signal: 'claimsAwaitingReview',
        signalTone: 'notice',
      },
      {
        label: 'Policies',
        href: ROUTES.DASHBOARD.INSURANCE_POLICIES,
        icon: ShieldPlus,
        keywords: [
          'cover',
          'in force',
          'lapsed',
          'grace',
          'waiting period',
          'dunning',
          'estate',
        ],
      },
      {
        label: 'Products',
        href: ROUTES.DASHBOARD.INSURANCE_PRODUCTS,
        icon: Package,
        keywords: [
          'catalogue',
          'catalog',
          'base rate',
          'exclusions',
          'pricing',
          'cover band',
          'free look',
        ],
      },
    ],
  },
  /**
   * M6 sits LAST, and that placement is the opposite of its importance.
   *
   * The file's ordering rule is the order an operator works in, and fraud is genuinely the
   * last thing in the lifecycle — it is the shield around everything above it, so it cannot
   * be understood before the things it protects. It is also the only group whose queue has a
   * clock running against it, which is why the case queue leads it and carries both badges.
   *
   * Three items, not four: the user risk profile is reached FROM a case rather than browsed,
   * so it has a route but no nav row. A nav entry to a per-user screen with no user id would
   * be a dead destination.
   */
  {
    id: 'fraud',
    label: 'Fraud & Risk',
    module: 'M6',
    icon: ShieldAlert,
    items: [
      {
        label: 'Case Queue',
        href: ROUTES.DASHBOARD.FRAUD,
        icon: Siren,
        keywords: [
          'fraud',
          'hold',
          'held',
          'risk',
          'step up',
          'sim swap',
          'mule',
          'takeover',
          'ato',
          'sla',
          'analyst',
          'clear',
          'confirm',
          'release',
        ],
        /**
         * The SLA breach, not the open count.
         *
         * An open queue is the normal state of a working engine, so badging it would mean a
         * permanent number an operator learns to ignore. A breach is a promise already broken
         * to a named person whose money is in suspense — that is what an alarm is for.
         */
        signal: 'fraudSlaBreached',
        signalTone: 'alarm',
      },
      {
        label: 'Risk Decisions',
        href: ROUTES.DASHBOARD.FRAUD_ASSESSMENTS,
        icon: ScanEye,
        keywords: [
          'assessments',
          'score',
          'signals',
          'weights',
          'model version',
          'decision',
          'allow',
          'block',
          'velocity',
          'geo',
          'device',
          'behaviour',
          'calibration',
        ],
      },
      {
        label: 'Watchlists',
        href: ROUTES.DASHBOARD.FRAUD_LISTS,
        icon: ListX,
        keywords: [
          'blocklist',
          'block list',
          'watchlist',
          'mule',
          'sanctions',
          'vpa',
          'listed',
          'registry',
        ],
      },
    ],
  },
];

// ── active-route resolution ─────────────────────────────────────────────────
const ALL_ITEMS: readonly NavItem[] = [
  NAV_ROOT,
  ...NAV_GROUPS.flatMap((group) => group.items),
];

/**
 * The single href that should read as active for `pathname`, or null.
 *
 * LONGEST match wins, and that is the whole point of this function rather than the
 * `startsWith` it replaces. Prefix matching lit up every ancestor at once: `/dashboard`
 * is a prefix of every page in the console, so "Overview" was highlighted on all of
 * them, and on the reconciliation screen both "Money" and "Reconciliation" claimed to
 * be where you were. A navigation whose one job is answering "where am I" answered with
 * three places.
 *
 * Longest-match also gets nested detail routes right for free: `/dashboard/payments/<id>`
 * has no longer candidate than `/dashboard/payments`, so a transaction detail page
 * correctly highlights Transactions.
 *
 * The match is anchored to a SEGMENT boundary (`===`, or the href plus `/`), so a future
 * `/dashboard/payments-archive` cannot be mistaken for a child of `/dashboard/payments`.
 */
export function resolveActiveHref(pathname: string): string | null {
  let best: string | null = null;
  for (const { href } of ALL_ITEMS) {
    const matches = pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

/** The group that owns `pathname`, so the drawer can auto-open it. */
export function resolveActiveGroupId(pathname: string): string | null {
  const active = resolveActiveHref(pathname);
  if (active === null) return null;
  return (
    NAV_GROUPS.find((group) =>
      group.items.some((item) => item.href === active),
    )?.id ?? null
  );
}

/** Human name of the current section, for the mobile top bar's orientation label. */
export function resolveActiveLabel(pathname: string): string {
  const active = resolveActiveHref(pathname);
  return ALL_ITEMS.find((item) => item.href === active)?.label ?? 'Admin';
}

// ── filter ──────────────────────────────────────────────────────────────────
function itemMatches(item: NavItem, needle: string): boolean {
  if (item.label.toLowerCase().includes(needle)) return true;
  return (item.keywords ?? []).some((word) => word.includes(needle));
}

export interface FilteredNav {
  rootMatches: boolean;
  groups: readonly NavGroup[];
  /** True when a filter is applied at all, so the drawer can force groups open. */
  filtering: boolean;
  matchCount: number;
}

/**
 * Filter the tree by a free-text query.
 *
 * A group whose own LABEL or module tag matches keeps all of its items, because
 * typing "money" should show the money section rather than nothing — the group name is
 * a legitimate thing to search for, and silently returning empty would read as "that
 * section does not exist".
 */
export function filterNav(query: string): FilteredNav {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return {
      rootMatches: true,
      groups: NAV_GROUPS,
      filtering: false,
      matchCount: ALL_ITEMS.length,
    };
  }

  const groups: NavGroup[] = [];
  let matchCount = 0;

  for (const group of NAV_GROUPS) {
    const groupHit =
      group.label.toLowerCase().includes(needle) ||
      group.module.toLowerCase().includes(needle);
    const items = groupHit
      ? group.items
      : group.items.filter((item) => itemMatches(item, needle));
    if (items.length > 0) {
      groups.push({ ...group, items });
      matchCount += items.length;
    }
  }

  const rootMatches = itemMatches(NAV_ROOT, needle);
  if (rootMatches) matchCount += 1;

  return { rootMatches, groups, filtering: true, matchCount };
}
