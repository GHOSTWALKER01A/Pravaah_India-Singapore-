'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { NavGroupRail, NavGroupSection } from '@/components/nav/nav-group';
import { NAV_RAIL_ROW, NavLink, RailLabel } from '@/components/nav/nav-item';
import { ALARM_SURFACE, ALARM_TEXT } from '@/components/nav/nav-tone';
import { RailPanel, useRailPanel } from '@/components/nav/rail-panel';
import {
  SidebarAccount,
  SidebarAccountRail,
} from '@/components/nav/sidebar-account';
import { useSidebar } from '@/components/nav/sidebar-context';
import {
  useNavSignals,
  useTrialBalanceOk,
} from '@/components/nav/use-nav-signals';
import { NAV_ROOT, filterNav, resolveActiveHref } from '@/features/nav';
import { ROUTES } from '@/features/routes';
import { cn } from '@/lib/utils/utils';

/** Everything the mobile focus trap treats as a stop. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ── rail-only pieces ────────────────────────────────────────────────────────
/**
 * Overview in the rail: an icon link that names itself on hover OR focus.
 *
 * Uses the flyout rather than a `title` attribute, because `title` never appears for a
 * keyboard user and the rail's entire premise is that an icon alone is not a label.
 */
const RailRootLink = ({
  active,
  onNavigate,
}: {
  active: boolean;
  onNavigate?: () => void;
}) => {
  const { open, coords, anchorProps, show, scheduleHide } = useRailPanel();

  return (
    <li>
      <div {...anchorProps} className="relative flex justify-center">
        <NavLink
          item={NAV_ROOT}
          active={active}
          signals={{}}
          onNavigate={onNavigate}
          compact
        />
        {open && (
          <RailPanel
            coords={coords}
            onPointerEnter={show}
            onPointerLeave={scheduleHide}
            className="min-w-0 py-1.5"
          >
            <RailLabel>{NAV_ROOT.label}</RailLabel>
          </RailPanel>
        )}
      </div>
    </li>
  );
};

/**
 * The trial-balance alarm, in the rail.
 *
 * Collapsing the drawer must not be a way to stop hearing that the books do not add up,
 * so the alarm survives into 56px as a destructive icon that links straight to the screen
 * where it gets resolved.
 */
const RailLedgerAlarm = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { open, coords, anchorProps, show, scheduleHide } = useRailPanel();

  return (
    <div className="shrink-0 border-t border-sidebar-border p-2">
      <div {...anchorProps} className="relative flex justify-center">
        <Link
          href={ROUTES.DASHBOARD.RECONCILIATION}
          onClick={onNavigate}
          className={cn(NAV_RAIL_ROW, ALARM_SURFACE, ALARM_TEXT)}
        >
          <TriangleAlert className="size-4.5" aria-hidden="true" />
          <span className="sr-only">
            Trial balance is out — open Reconciliation
          </span>
        </Link>
        {open && (
          <RailPanel
            coords={coords}
            onPointerEnter={show}
            onPointerLeave={scheduleHide}
            className="py-1.5"
          >
            <p className={cn('px-1 text-sm font-medium', ALARM_TEXT)}>
              Trial balance is out
            </p>
            <p className="mt-0.5 px-1 text-xs text-muted-foreground">
              The ledger does not net to zero.
            </p>
          </RailPanel>
        )}
      </div>
    </div>
  );
};

// ── drawer ──────────────────────────────────────────────────────────────────
export const AppSidebar = () => {
  const pathname = usePathname();
  const {
    isDesktop,
    collapsed,
    toggleCollapsed,
    mobileOpen,
    closeMobile,
    isGroupOpen,
    toggleGroup,
  } = useSidebar();

  const signals = useNavSignals();
  const trialBalanceOk = useTrialBalanceOk();
  const [query, setQuery] = useState('');

  const asideRef = useRef<HTMLElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();

  const activeHref = resolveActiveHref(pathname);
  const filtered = filterNav(query);

  /** The rail exists only on desktop — the overlay drawer is always full width. */
  const rail = isDesktop && collapsed;
  const ledgerBroken = trialBalanceOk === false;

  /** Expand first if collapsed, then focus the filter. */
  const focusFilter = useCallback(() => {
    if (rail) {
      toggleCollapsed();
      // The input does not exist yet in rail mode, so focus waits for the paint that
      // creates it.
      requestAnimationFrame(() => filterRef.current?.focus());
      return;
    }
    filterRef.current?.focus();
  }, [rail, toggleCollapsed]);

  /**
   * Collapsing clears the filter first.
   *
   * A query left applied while collapsing would silently drop groups out of the rail,
   * where there is no visible input to explain the absence — the operator would just see
   * sections that used to be there gone.
   */
  const handleCollapse = useCallback(() => {
    if (!collapsed) setQuery('');
    toggleCollapsed();
  }, [collapsed, toggleCollapsed]);

  /**
   * `/` focuses the filter, the way it does in every other console an operator uses.
   * Ignored while they are already typing, or the shortcut would swallow the character.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      focusFilter();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusFilter]);

  /**
   * Modal behaviour for the overlay: Escape closes, Tab cycles inside, the page behind
   * cannot scroll, and focus returns to whatever opened it.
   *
   * Rows inside a collapsed group are excluded via `closest('[inert]')`. Without that the
   * computed "last focusable" could be a row the browser correctly refuses to focus, and
   * the cycle would leak out of the drawer at the bottom.
   */
  useEffect(() => {
    if (!mobileOpen) return;
    const node = asideRef.current;
    if (!node) return;

    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dismissRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobile();
        return;
      }
      if (event.key !== 'Tab') return;

      const stops = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter(
        (el) =>
          el.closest('[inert]') === null && el.getClientRects().length > 0,
      );
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = restoreOverflow;
      previous?.focus();
    };
  }, [mobileOpen, closeMobile]);

  const onNavigate = mobileOpen ? closeMobile : undefined;

  return (
    <>
      {/* Scrim — below `lg` only. On desktop the drawer never covers anything. */}
      <div
        onClick={closeMobile}
        aria-hidden="true"
        className={cn(
          'fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 lg:hidden',
          'motion-reduce:transition-none',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        ref={asideRef}
        id="app-sidebar"
        // Below `lg` and open this genuinely is a modal dialog; above it, it is page
        // furniture. The `nav` landmark lives inside, so it survives either role.
        role={!isDesktop && mobileOpen ? 'dialog' : undefined}
        aria-modal={!isDesktop && mobileOpen ? true : undefined}
        aria-labelledby={headingId}
        // Off-canvas but still in the DOM: without this a keyboard user tabs into an
        // invisible drawer.
        inert={!isDesktop && !mobileOpen}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-72 flex-col',
          'border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
          // The off-canvas slide is scoped to `max-lg:` deliberately. ANY transform on
          // this element at `lg` would make it a containing block and reparent every rail
          // flyout back inside the scrolling nav, where it would be clipped. The
          // transition itself lives in globals.css — see `#app-sidebar` there for why the
          // cascade has to be written by hand.
          'max-lg:shadow-xl max-lg:shadow-black/25',
          mobileOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
          'lg:static lg:z-auto lg:shadow-none',
          rail ? 'lg:w-14' : 'lg:w-64',
        )}
      >
        {/* ── header ── */}
        <div
          className={cn(
            'flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border',
            rail ? 'justify-center px-2' : 'px-3',
          )}
        >
          {rail ? (
            <h2 id={headingId} className="sr-only">
              Pravaah Admin
            </h2>
          ) : (
            <>
              {/* The seal, at the small cut — five rings rather than eleven,
                  because the mark is 28px here and the display cut would silt
                  up. Decorative: the heading beside it already says the name.
                  Not next/image — it is a fixed-size local vector, so the
                  optimiser has nothing to optimise and would only add a
                  request. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/pravaah-seal.svg"
                alt=""
                aria-hidden="true"
                width={28}
                height={28}
                className="size-7 shrink-0"
              />
              <h2
                id={headingId}
                className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight"
              >
                Pravaah Admin
              </h2>
            </>
          )}

          {/* Desktop collapses, mobile dismisses. One slot, because they are the same
              intention: get the navigation out of the way. */}
          <button
            ref={dismissRef}
            type="button"
            onClick={isDesktop ? handleCollapse : closeMobile}
            aria-label={
              isDesktop
                ? collapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
                : 'Close navigation'
            }
            aria-controls="app-sidebar"
            aria-expanded={isDesktop ? !collapsed : mobileOpen}
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md',
              'text-muted-foreground transition-colors duration-150',
              'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
            )}
          >
            {!isDesktop ? (
              <X className="size-4" aria-hidden="true" />
            ) : collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* ── filter ──
            In the rail this becomes a magnifier that expands the drawer and lands the
            caret in the field, so "find a section" never requires knowing that you must
            expand first. */}
        <div className="shrink-0 px-2 pt-2">
          {rail ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={focusFilter}
                aria-label="Find a section"
                className={cn(
                  NAV_RAIL_ROW,
                  'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
                )}
              >
                <Search className="size-4.5" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <label className="sr-only" htmlFor="nav-filter">
                Find a section
              </label>
              <input
                ref={filterRef}
                id="nav-filter"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setQuery('');
                  }
                }}
                placeholder="Find a section"
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  'h-9 w-full rounded-md border border-sidebar-border bg-background/60 pl-8 pr-2',
                  'text-sm text-sidebar-foreground placeholder:text-muted-foreground',
                  'transition-colors duration-150',
                  'focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring focus-visible:outline-none',
                  // Chrome paints the native search-clear button in the OS scheme, where
                  // it fights the dark theme. Escape clears the field instead.
                  '[&::-webkit-search-cancel-button]:hidden',
                )}
              />
            </div>
          )}
        </div>

        {/* ── sections ── */}
        <nav
          aria-label="Sections"
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2"
        >
          {rail ? (
            <ul className="space-y-1">
              <RailRootLink
                active={NAV_ROOT.href === activeHref}
                onNavigate={onNavigate}
              />
              <li
                aria-hidden="true"
                className="mx-2 my-2 border-t border-sidebar-border"
              />
              {filtered.groups.map((group) => (
                <NavGroupRail
                  key={group.id}
                  group={group}
                  activeHref={activeHref}
                  signals={signals}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          ) : (
            <ul className="space-y-0.5">
              {filtered.rootMatches && (
                <li>
                  <NavLink
                    item={NAV_ROOT}
                    active={NAV_ROOT.href === activeHref}
                    signals={signals}
                    onNavigate={onNavigate}
                  />
                </li>
              )}

              {filtered.groups.map((group) => (
                <NavGroupSection
                  key={group.id}
                  group={group}
                  activeHref={activeHref}
                  signals={signals}
                  open={isGroupOpen(group.id)}
                  onToggle={() => toggleGroup(group.id)}
                  forcedOpen={filtered.filtering}
                  onNavigate={onNavigate}
                  // More space above a group heading than below it: this gap is what
                  // separates a section from the previous section's last item.
                  className="pt-3"
                />
              ))}

              {filtered.matchCount === 0 && (
                <li className="px-2.5 py-6">
                  <p className="text-sm text-sidebar-foreground">
                    Nothing matches “{query.trim()}”.
                  </p>
                  {/* Teaches that the filter reads the vocabulary of the job, not only
                      the words printed in the list. */}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Sections also match on what they contain — try “mismatch”,
                    “rotation”, or “aggregator”.
                  </p>
                </li>
              )}
            </ul>
          )}
        </nav>

        {/* ── ledger alarm ──
            The one status the drawer carries, and it is not a badge because it is not a
            count: a broken trial balance means the books do not add up, which outranks
            every queue length in the console. Absent entirely while the ledger is sound,
            so a healthy system costs no chrome. */}
        {ledgerBroken &&
          (rail ? (
            <RailLedgerAlarm onNavigate={onNavigate} />
          ) : (
            <Link
              href={ROUTES.DASHBOARD.RECONCILIATION}
              onClick={onNavigate}
              className={cn(
                'shrink-0 border-t border-sidebar-border px-3 py-2.5',
                'transition-colors duration-150 hover:bg-red-600/5 dark:hover:bg-red-400/5',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
              )}
            >
              <span
                className={cn(
                  'flex items-center gap-1.5 text-xs font-medium',
                  ALARM_TEXT,
                )}
              >
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                Trial balance is out
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                The ledger does not net to zero. Open Reconciliation.
              </span>
            </Link>
          ))}

        {rail ? <SidebarAccountRail /> : <SidebarAccount />}
      </aside>
    </>
  );
};
