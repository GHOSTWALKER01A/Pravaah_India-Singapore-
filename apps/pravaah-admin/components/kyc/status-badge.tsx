/**
 * Colour-coded pill for any KYC/review/check status. Unknown values fall back
 * to a neutral style, so it is safe to pass a raw string from the API.
 */
const TONE: Record<string, string> = {
  // positive
  PASSED:
    'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  VERIFIED:
    'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  APPROVED:
    'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  RESOLVED:
    'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  // M1 consent / data-session
  ACTIVE:
    'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  COMPLETED:
    'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400',
  PARTIAL:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  PAUSED:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  // negative
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  REJECTED: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  EXPIRED: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  // attention
  MANUAL_REVIEW:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  IN_REVIEW:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  ACTION_REQUIRED:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  CLAIMED:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  // in-flight / neutral-active
  PENDING: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
  IN_PROGRESS:
    'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
  OPEN: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
};

const NEUTRAL =
  'bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400';

export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? NEUTRAL;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status.replaceAll('_', ' ')}
    </span>
  );
}
