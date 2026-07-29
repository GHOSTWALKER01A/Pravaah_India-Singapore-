'use client';

import Link from 'next/link';

import { NavBadge } from '@/components/nav/nav-badge';
import type { NavItem, NavSignalValues } from '@/features/nav';
import { cn } from '@/lib/utils/utils';

/**
 * Shared row styling for everything clickable in the drawer — items, group headers, the
 * account controls. One declaration, so a group header and a nav item cannot drift into
 * two slightly different heights or two different focus rings.
 *
 * 44px below `lg` and 36px above it: the overlay drawer is touched, the desktop rail is
 * pointed at, and an ops console earns the tighter desktop density.
 */
export const NAV_ROW = cn(
  'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm lg:h-9',
  'transition-colors duration-150',
  // Outline rather than a ring: the offset is transparent, so the same declaration
  // works on the sidebar surface and inside a popover without a matching offset colour.
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
);

/**
 * The inactive/active treatment, applied to items and to group headers alike.
 *
 * Active carries THREE reinforcing signals — a tinted surface, full-contrast text at
 * medium weight, and an accent-coloured icon. Deliberately no coloured left bar: three
 * properties already make the current row unmistakable at a glance, and a 2px accent
 * rail on a list row is the decorative default rather than a decision.
 */
export function navRowTone(active: boolean): string {
  return active
    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
    : 'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground';
}

/** Square icon-button geometry, shared by every control that lives in the 56px rail. */
export const NAV_RAIL_ROW = cn(
  'flex size-9 items-center justify-center rounded-md transition-colors duration-150',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
);

export const NavLink = ({
  item,
  active,
  signals,
  onNavigate,
  /**
   * Icon-only, for the collapsed rail. The label is still rendered for assistive tech —
   * an icon with no accessible name is an unlabelled button, and the flyout that names it
   * visually only appears on hover or focus.
   */
  compact = false,
}: {
  item: NavItem;
  active: boolean;
  signals: NavSignalValues;
  /** Lets the overlay drawer close itself the moment a destination is chosen. */
  onNavigate?: () => void;
  compact?: boolean;
}) => {
  const Icon = item.icon;
  const count = item.signal ? signals[item.signal] : undefined;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      // The assistive-tech answer to "where am I", and the reason resolveActiveHref
      // returns exactly one href instead of every matching ancestor.
      aria-current={active ? 'page' : undefined}
      className={cn(compact ? NAV_RAIL_ROW : NAV_ROW, navRowTone(active))}
    >
      <Icon
        className={cn('size-4.5 shrink-0', active && 'text-primary')}
        aria-hidden="true"
      />
      {compact ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <>
          <span className="truncate">{item.label}</span>
          <NavBadge
            count={count}
            tone={item.signalTone ?? 'notice'}
            label={`${item.label.toLowerCase()} awaiting attention`}
          />
        </>
      )}
    </Link>
  );
};

/**
 * The hover/focus label for anything in the rail.
 *
 * Shared so a group flyout, a lone icon link and the account button all name themselves
 * the same way — and so none of them falls back to `title`, which a keyboard user never
 * sees.
 */
export const RailLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="whitespace-nowrap px-1 text-sm">{children}</span>
);
