'use client';

import { LogOut, Moon, Sun } from 'lucide-react';

import { useAuth } from '@/app/context/auth-context';
import { useTheme } from '@/app/context/theme-context';
import { NAV_ROW } from '@/components/nav/nav-item';
import { DESTRUCTIVE_HOVER } from '@/components/nav/nav-tone';
import { RailPanel, useRailPanel } from '@/components/nav/rail-panel';
import { cn } from '@/lib/utils/utils';

/** `SENIOR_REVIEWER` → `Senior reviewer`. The enum is a wire format, not a label. */
function formatRole(role: string): string {
  const words = role.toLowerCase().split('_');
  const [first, ...rest] = words;
  if (!first) return role;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

const ThemeToggle = ({ compact = false }: { compact?: boolean }) => {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = theme === 'dark' ? Sun : Moon;

  if (compact) {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        // Names the OUTCOME, not the current state. "Dark mode" as a label leaves the
        // operator guessing whether it describes what they have or what they'd get.
        aria-label={`Switch to ${next} theme`}
        title={`Switch to ${next} theme`}
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors duration-150',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(
        NAV_ROW,
        'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
      )}
    >
      <Icon className="size-4.5 shrink-0" aria-hidden="true" />
      <span className="truncate">Switch to {next} theme</span>
    </button>
  );
};

const SignOut = () => {
  const { logout } = useAuth();
  return (
    <button
      type="button"
      onClick={logout}
      className={cn(
        NAV_ROW,
        'text-muted-foreground transition-colors',
        // The one destructive control in the drawer. It stays neutral until intent is
        // shown, so colour in this surface still means "current selection" everywhere else.
        DESTRUCTIVE_HOVER,
      )}
    >
      <LogOut className="size-4.5 shrink-0" aria-hidden="true" />
      <span className="truncate">Sign out</span>
    </button>
  );
};

const Identity = () => {
  const { user } = useAuth();
  const email = user?.email ?? '—';
  const initial = (user?.email ?? '?').charAt(0).toUpperCase();

  return (
    // `flex-1` so the theme toggle beside this block is pushed to the far edge rather than
    // sitting flush against a truncated email address.
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground"
        aria-hidden="true"
      >
        {initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-sidebar-foreground" title={email}>
          {email}
        </span>
        {/* Which role you hold decides what the console will let you do, so it belongs
            on screen rather than one API call away. */}
        <span className="block truncate text-[11px] text-muted-foreground">
          {user ? formatRole(user.role) : 'Signed out'}
        </span>
      </span>
    </div>
  );
};

/** The drawer footer, full width. */
export const SidebarAccount = () => (
  <div className="space-y-1 border-t border-sidebar-border p-2">
    <div className="flex items-center gap-1 px-0.5 py-1">
      <Identity />
      <ThemeToggle compact />
    </div>
    <SignOut />
  </div>
);

/**
 * The same footer in the icon rail: an avatar that opens the identity and both controls.
 *
 * Collapsing must not cost the operator the ability to see who they are signed in as or
 * to sign out — a rail that hides the exit is a rail people refuse to use.
 */
export const SidebarAccountRail = () => {
  const { user } = useAuth();
  const { open, coords, anchorProps, show, scheduleHide } = useRailPanel();
  const initial = (user?.email ?? '?').charAt(0).toUpperCase();

  return (
    <div className="border-t border-sidebar-border p-2">
      <div {...anchorProps} className="relative flex justify-center">
        <button
          type="button"
          onClick={show}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`Account: ${user?.email ?? 'signed out'}`}
          className={cn(
            'flex size-9 items-center justify-center rounded-md transition-colors duration-150',
            'hover:bg-sidebar-accent/70',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
          )}
        >
          <span
            className="flex size-7 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground"
            aria-hidden="true"
          >
            {initial}
          </span>
        </button>

        {open && (
          <RailPanel
            coords={coords}
            onPointerEnter={show}
            onPointerLeave={scheduleHide}
          >
            <div className="px-1.5 pb-2 pt-1">
              <Identity />
            </div>
            <div className="space-y-0.5 border-t border-sidebar-border pt-1.5">
              <ThemeToggle />
              <SignOut />
            </div>
          </RailPanel>
        )}
      </div>
    </div>
  );
};
