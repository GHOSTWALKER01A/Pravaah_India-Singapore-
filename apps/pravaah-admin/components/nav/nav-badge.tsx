import { ALARM_CHIP, NOTICE_CHIP } from '@/components/nav/nav-tone';
import type { NavBadgeTone } from '@/features/nav';
import { cn } from '@/lib/utils/utils';

/**
 * A count on a navigation row.
 *
 * Renders NOTHING at zero, and that is the rule that keeps the badges worth reading: a
 * row of grey zeroes trains an operator to ignore the one that turns into a four. The
 * component returns null rather than the caller checking, so no future call site can
 * forget.
 *
 * `alarm` is a filled destructive chip — money or a person is stuck behind it. `notice`
 * is a quiet neutral count for a queue that is merely non-empty. Nothing else gets a
 * badge, because a number an operator cannot act on is competing with the ones they can.
 */
export const NavBadge = ({
  count,
  tone,
  label,
  className,
}: {
  count: number | undefined;
  tone: NavBadgeTone;
  /** What the number means, for screen readers — "12" alone tells them nothing. */
  label: string;
  className?: string;
}) => {
  if (count === undefined || count <= 0) return null;

  return (
    <span
      className={cn(
        'ml-auto inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5',
        'text-[11px] font-semibold tabular-nums leading-5',
        tone === 'alarm' ? ALARM_CHIP : NOTICE_CHIP,
        className,
      )}
    >
      {/* Capped so a runaway backlog cannot widen the row and push the label into an
          ellipsis. The exact number is still available to assistive tech below. */}
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">
        {count} {label}
      </span>
    </span>
  );
};
