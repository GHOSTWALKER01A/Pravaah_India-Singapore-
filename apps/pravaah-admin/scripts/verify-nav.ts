/**
 * Navigation self-check — the drawer's pure logic, against the real module.
 *
 *   npx tsx scripts/verify-nav.ts
 *
 * `resolveActiveHref` replaced a `startsWith` prefix match that lit up every ancestor at
 * once: "Overview" was highlighted on all eleven pages, and on the reconciliation screen
 * both "Money" and "Reconciliation" claimed to be the current location. A regression there
 * is invisible in a typecheck and quietly breaks the one question navigation exists to
 * answer, which is why it is pinned here rather than left to review.
 *
 * No test runner is wired into this app, so this is a script in the same spirit as the
 * backend's `verify:passport` / `verify:scoring`: run it after touching `features/nav.ts`.
 */
import {
  NAV_GROUPS,
  NAV_ROOT,
  filterNav,
  resolveActiveGroupId,
  resolveActiveHref,
  resolveActiveLabel,
} from '@/features/nav';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

console.log('\nactive href — exactly one row, longest match wins');
check('/dashboard', resolveActiveHref('/dashboard'), '/dashboard');
check('/dashboard/kyc', resolveActiveHref('/dashboard/kyc'), '/dashboard/kyc');
check(
  'kyc detail resolves to its list',
  resolveActiveHref('/dashboard/kyc/8f1c-4a2b'),
  '/dashboard/kyc',
);
check(
  'payments beats the /dashboard prefix',
  resolveActiveHref('/dashboard/payments'),
  '/dashboard/payments',
);
check(
  'reconciliation beats /dashboard/payments',
  resolveActiveHref('/dashboard/payments/reconciliation'),
  '/dashboard/payments/reconciliation',
);
check(
  'disputes beats /dashboard/payments',
  resolveActiveHref('/dashboard/payments/disputes'),
  '/dashboard/payments/disputes',
);
check(
  'txn detail resolves to Transactions, not Overview',
  resolveActiveHref('/dashboard/payments/2f9a-11ee'),
  '/dashboard/payments',
);
check(
  'segment boundary: a sibling path is not a child',
  resolveActiveHref('/dashboard/payments-archive'),
  '/dashboard',
);
check('unknown route outside the console', resolveActiveHref('/login'), null);

console.log('\nowning group + label');
check(
  'reconciliation belongs to money',
  resolveActiveGroupId('/dashboard/payments/reconciliation'),
  'money',
);
check('issuer keys belong to passport', resolveActiveGroupId('/dashboard/issuer-keys'), 'passport');
check('overview belongs to no group', resolveActiveGroupId('/dashboard'), null);
check(
  'topbar label on a detail route',
  resolveActiveLabel('/dashboard/payments/2f9a-11ee'),
  'Transactions',
);

console.log('\nfilter');
const all = filterNav('');
check('empty query keeps every group', all.groups.length, NAV_GROUPS.length);
check('empty query is not filtering', all.filtering, false);

const mismatch = filterNav('mismatch');
check('keyword hit finds one group', mismatch.groups.length, 1);
check(
  'keyword hit finds Reconciliation',
  mismatch.groups[0]?.items.map((i) => i.label),
  ['Reconciliation'],
);
check('keyword hit excludes the root', mismatch.rootMatches, false);

const money = filterNav('money');
check(
  'group-label hit keeps all of its items',
  money.groups[0]?.items.length,
  NAV_GROUPS.find((g) => g.id === 'money')?.items.length,
);

const byModule = filterNav('M3');
check('module tag is searchable', byModule.groups[0]?.id, 'passport');

const none = filterNav('zzzz');
check('no match reports zero', none.matchCount, 0);
check('no match returns no groups', none.groups.length, 0);

console.log('\ntree shape');
const hrefs = [NAV_ROOT, ...NAV_GROUPS.flatMap((g) => g.items)].map((i) => i.href);
check('no duplicate hrefs', hrefs.length, new Set(hrefs).size);
check(
  'every group has a module tag and items',
  NAV_GROUPS.every((g) => g.module.length > 0 && g.items.length > 0),
  true,
);

console.log(
  failures === 0
    ? '\nAll nav checks passed.\n'
    : `\n${failures} nav check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
