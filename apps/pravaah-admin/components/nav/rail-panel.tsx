'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from 'react';

import { cn } from '@/lib/utils/utils';

/** Grace period between leaving the icon and entering the panel across the gap. */
const HIDE_DELAY_MS = 140;

interface Coords {
  top: number;
  left: number;
}

/**
 * The open/close and positioning machinery for a collapsed-rail flyout.
 *
 * The panel is `position: fixed` and measured from its anchor rather than positioned
 * `absolute` inside it, because the rail's item list scrolls: an absolutely positioned
 * child would be clipped by that scroll container the moment the list is long enough to
 * matter — which is precisely the "many more sections" case the rail exists to serve.
 *
 * It is rendered IN TREE rather than through a portal so that keyboard order stays
 * natural: focus the group icon, press Tab, and you are on the first item inside the
 * panel. That works only while no ancestor establishes a containing block, so the
 * desktop drawer deliberately carries no `transform`, `filter`, `backdrop-filter`,
 * `perspective`, `contain` or `will-change` — the off-canvas slide is scoped to
 * `max-lg:` for exactly this reason. Adding one of those at `lg` would silently reparent
 * every flyout back inside the scroll container.
 */
export function useRailPanel() {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHide = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Overlaps the anchor by 4px so a pointer travelling right does not cross a dead
    // gap wider than the grace period can cover.
    setCoords({ top: rect.top, left: rect.right - 4 });
  }, []);

  const show = useCallback(() => {
    clearHide();
    measure();
    setOpen(true);
  }, [clearHide, measure]);

  const hideNow = useCallback(() => {
    clearHide();
    setOpen(false);
  }, [clearHide]);

  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  }, [clearHide]);

  useEffect(() => clearHide, [clearHide]);

  // Re-measure while open. A window resize or a scrolled rail would otherwise leave the
  // panel floating beside nothing.
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hideNow();
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, [open, measure, hideNow]);

  /**
   * Spread onto the element that wraps BOTH the trigger and the panel.
   *
   * Focus is handled with capture-phase handlers plus a `contains` test on
   * `relatedTarget`, so tabbing from the icon into the panel keeps it open while tabbing
   * past the last item closes it — without either one needing to know the other exists.
   */
  const anchorProps = {
    ref: anchorRef,
    onPointerEnter: show,
    onPointerLeave: scheduleHide,
    onFocusCapture: show,
    onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      hideNow();
    },
  };

  return { open, coords, anchorProps, show, scheduleHide, hideNow };
}

/**
 * The floating surface itself.
 *
 * `maxHeight` is derived from the anchor's viewport position instead of measuring the
 * panel, so a group with many items scrolls inside the flyout rather than running off
 * the bottom of the screen — and the rail keeps working at any viewport height without
 * a measurement pass.
 */
export const RailPanel = ({
  coords,
  onPointerEnter,
  onPointerLeave,
  children,
  className,
}: {
  coords: Coords | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: React.ReactNode;
  className?: string;
}) => {
  if (!coords) return null;

  return (
    <div
      // `fixed` + high z so the panel clears the drawer, the sticky top bar, and any
      // table header on the page behind it.
      className={cn(
        'fixed z-50 min-w-52 max-w-64 overflow-y-auto rounded-lg border border-sidebar-border',
        'bg-popover p-1.5 text-popover-foreground shadow-lg shadow-black/10 dark:shadow-black/40',
        'motion-safe:animate-rail-panel',
        className,
      )}
      style={{
        top: coords.top,
        left: coords.left,
        maxHeight: `calc(100dvh - ${Math.max(coords.top, 0)}px - 1rem)`,
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  );
};
