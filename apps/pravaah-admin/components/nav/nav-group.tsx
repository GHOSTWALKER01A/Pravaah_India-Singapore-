'use client';

import { ChevronDown } from 'lucide-react';
import { useId } from 'react';

import { NAV_RAIL_ROW, NAV_ROW, NavLink } from '@/components/nav/nav-item';
import { ALARM_DOT, NOTICE_DOT } from '@/components/nav/nav-tone';
import { RailPanel, useRailPanel } from '@/components/nav/rail-panel';
import type { NavGroup, NavSignalValues } from '@/features/nav';
import { cn } from '@/lib/utils/utils';

interface GroupProps {
  group: NavGroup;
  activeHref: string | null;
  signals: NavSignalValues;
  onNavigate?: () => void;
}

/** Total badge counts for a group, split by tone — the rail has room for a dot, not a number. */
function summarise(group: NavGroup, signals: NavSignalValues) {
  let alarm = 0;
  let notice = 0;
  for (const item of group.items) {
    const count = item.signal ? (signals[item.signal] ?? 0) : 0;
    if (count <= 0) continue;
    if (item.signalTone === 'alarm') alarm += count;
    else notice += count;
  }
  return { alarm, notice };
}

// ── expanded ────────────────────────────────────────────────────────────────
/**
 * A collapsible group in the full-width drawer.
 *
 * The disclosure animates with `grid-template-rows: 0fr → 1fr`, which gives a real
 * auto-height transition without JavaScript measuring the content. That matters here
 * because a group's height is not knowable in advance: the whole point of this nav is
 * that sections get added to it.
 *
 * A group the operator has collapsed is NOT force-opened when it owns the current route.
 * Reopening it would overrule a deliberate choice every time they navigated; instead the
 * header carries an accent dot, so "where am I" still has an answer and the collapse
 * still holds.
 */
export const NavGroupSection = ({
  group,
  activeHref,
  signals,
  open,
  onToggle,
  onNavigate,
  /** Set while the filter is active: disclosure is suspended so every hit is visible. */
  forcedOpen = false,
  className,
}: GroupProps & {
  open: boolean;
  onToggle: () => void;
  forcedOpen?: boolean;
  className?: string;
}) => {
  const panelId = useId();
  const expanded = forcedOpen || open;
  const hasActiveChild = group.items.some((item) => item.href === activeHref);
  const { alarm, notice } = summarise(group, signals);

  return (
    <li className={className}>
      <button
        type="button"
        onClick={onToggle}
        // Suppressed while filtering, because the control genuinely does nothing then.
        disabled={forcedOpen}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={cn(
          NAV_ROW,
          'h-9 gap-2 text-xs font-medium lg:h-7',
          'text-muted-foreground hover:text-foreground disabled:pointer-events-none',
          hasActiveChild && !expanded && 'text-foreground',
        )}
      >
        <span className="truncate">{group.label}</span>

        {/* The M0–M7 module this section implements. The team plans, talks and ships in
            these numbers, so carrying them here maps the console onto the build plan
            instead of making an operator hold the mapping in their head. */}
        <span className="ml-auto shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
          {group.module}
        </span>

        {/* Survives a collapse: the only trace of the current location once the group
            that owns it is shut. */}
        {hasActiveChild && !expanded && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
        {!expanded && (alarm > 0 || notice > 0) && (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              alarm > 0 ? ALARM_DOT : NOTICE_DOT,
            )}
            aria-hidden="true"
          />
        )}

        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-150',
            !expanded && '-rotate-90',
          )}
          aria-hidden="true"
        />
      </button>

      <div
        id={panelId}
        // `grid` + fractional rows is what makes this animate to auto height. The inner
        // wrapper needs `min-h-0` or the grid refuses to shrink below its content.
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <ul
          className="min-h-0 space-y-0.5 overflow-hidden"
          // Hidden content stays out of the tab order and out of a screen reader's path
          // while the group is shut.
          aria-hidden={!expanded}
          inert={!expanded}
        >
          {group.items.map((item) => (
            <li key={item.href}>
              <NavLink
                item={item}
                active={item.href === activeHref}
                signals={signals}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
};

// ── collapsed rail ──────────────────────────────────────────────────────────
/**
 * A group in the icon rail: one icon, with the group's items in a flyout.
 *
 * One icon per GROUP rather than per item is the decision that lets the rail survive
 * growth. A rail of twelve item icons is already hard to scan and a rail of twenty is
 * useless, while a rail of group icons stays readable no matter how many pages land
 * inside each one — the cost is one hover, and the group label is right there in the
 * panel header to confirm the guess.
 */
export const NavGroupRail = ({
  group,
  activeHref,
  signals,
  onNavigate,
}: GroupProps) => {
  const { open, coords, anchorProps, show, scheduleHide } = useRailPanel();
  const Icon = group.icon;
  const hasActiveChild = group.items.some((item) => item.href === activeHref);
  const { alarm, notice } = summarise(group, signals);
  const dot = alarm > 0 || notice > 0;

  return (
    <li>
      <div {...anchorProps} className="relative flex justify-center">
        <button
          type="button"
          // Hover is not an interaction a keyboard or touch user has, so the trigger is a
          // real button: Enter or Space opens the same panel that a pointer reveals.
          onClick={show}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${group.label} — ${group.module}`}
          className={cn(
            NAV_RAIL_ROW,
            hasActiveChild
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
          )}
        >
          <Icon
            className={cn('size-4.5', hasActiveChild && 'text-primary')}
            aria-hidden="true"
          />
          {dot && (
            <>
              {/* Ringed in the sidebar colour so the dot stays legible where it overlaps
                  the icon's own strokes. */}
              <span
                className={cn(
                  'absolute right-1 top-1 size-2 rounded-full ring-2 ring-sidebar',
                  alarm > 0 ? ALARM_DOT : NOTICE_DOT,
                )}
                aria-hidden="true"
              />
              <span className="sr-only">
                {alarm + notice} items awaiting attention
              </span>
            </>
          )}
        </button>

        {open && (
          <RailPanel
            coords={coords}
            onPointerEnter={show}
            onPointerLeave={scheduleHide}
          >
            <div className="flex items-baseline gap-2 px-2.5 pb-1.5 pt-1">
              <span className="text-sm font-medium">{group.label}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {group.module}
              </span>
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    item={item}
                    active={item.href === activeHref}
                    signals={signals}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </RailPanel>
        )}
      </div>
    </li>
  );
};
