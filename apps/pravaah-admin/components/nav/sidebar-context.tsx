'use client';

import { usePathname } from 'next/navigation';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  collapsedPreference,
  getDesktopServerSnapshot,
  getDesktopSnapshot,
  groupsPreference,
  subscribeDesktop,
} from '@/components/nav/nav-preferences';

interface SidebarState {
  isDesktop: boolean;

  /** Desktop only: the drawer is an icon rail. Persisted. */
  collapsed: boolean;
  toggleCollapsed: () => void;

  /** Below `lg`: the off-canvas overlay is open. Never persisted. */
  mobileOpen: boolean;
  openMobile: () => void;
  closeMobile: () => void;

  isGroupOpen: (groupId: string) => boolean;
  toggleGroup: (groupId: string) => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

/**
 * Owns every piece of drawer state, because two separate subtrees need it: the drawer
 * itself and the mobile top bar's trigger, which sits outside the drawer.
 *
 * Nothing here copies external state into React state inside an effect. The viewport and
 * both persisted preferences are read through `useSyncExternalStore`, and "close on
 * navigation" is DERIVED rather than synchronised — see `mobileOpen` below.
 */
export const SidebarProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const pathname = usePathname();

  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    getDesktopServerSnapshot,
  );
  const collapsed = useSyncExternalStore(
    collapsedPreference.subscribe,
    collapsedPreference.get,
    collapsedPreference.getServer,
  );
  const groups = useSyncExternalStore(
    groupsPreference.subscribe,
    groupsPreference.get,
    groupsPreference.getServer,
  );

  /**
   * The overlay records the route it was opened on.
   *
   * Tapping a destination in an overlay drawer means "take me there", so the drawer must
   * not still be covering the page afterwards. Storing the route it opened at makes
   * closing-on-navigation a pure derivation — any pathname change makes the stored one
   * stale — instead of an effect that fires a second render after every route change.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);

  // Also gated on `!isDesktop`, so crossing up into desktop cannot leave the scrim and
  // the focus trap armed behind a drawer that is now permanently visible.
  const mobileOpen = !isDesktop && openedAt === pathname;

  /**
   * A CSS hook, not state.
   *
   * The width and slide transitions must not run on the first paint: a returning operator
   * who had collapsed the drawer would watch it animate 256px → 56px, which reads as the
   * app rearranging itself rather than as a remembered preference. Writing an attribute to
   * the DOM is what effects are actually for, and it keeps this out of the render path.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.navReady = '';
    return () => {
      delete root.dataset.navReady;
    };
  }, []);

  const toggleCollapsed = useCallback(() => {
    collapsedPreference.set(!collapsedPreference.get());
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    const current = groupsPreference.get();
    // Absent means open, so the first click on an untouched group must write `false`.
    groupsPreference.set({ ...current, [groupId]: current[groupId] === false });
  }, []);

  const isGroupOpen = useCallback(
    (groupId: string) => groups[groupId] !== false,
    [groups],
  );

  const openMobile = useCallback(() => setOpenedAt(pathname), [pathname]);
  const closeMobile = useCallback(() => setOpenedAt(null), []);

  const value = useMemo<SidebarState>(
    () => ({
      isDesktop,
      collapsed,
      toggleCollapsed,
      mobileOpen,
      openMobile,
      closeMobile,
      isGroupOpen,
      toggleGroup,
    }),
    [
      isDesktop,
      collapsed,
      toggleCollapsed,
      mobileOpen,
      openMobile,
      closeMobile,
      isGroupOpen,
      toggleGroup,
    ],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
};

export const useSidebar = (): SidebarState => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used inside SidebarProvider');
  }
  return context;
};
