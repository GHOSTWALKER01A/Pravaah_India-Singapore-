'use client';

import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';

import { useSidebar } from '@/components/nav/sidebar-context';
import { resolveActiveLabel } from '@/features/nav';
import { cn } from '@/lib/utils/utils';

/**
 * The narrow-viewport shell: the only way to reach the drawer once it is off-canvas.
 *
 * Hidden at `lg` and above, where the drawer is permanently visible and carries its own
 * collapse control — a second trigger up here would be two controls for one intention.
 *
 * It also names the current section. On a detail route like
 * `/dashboard/payments/<id>` the drawer is closed and the page heading is about one
 * transaction, so without this there is nothing on screen saying which part of the
 * console you are in.
 */
export const DashboardTopbar = () => {
  const pathname = usePathname();
  const { openMobile, mobileOpen } = useSidebar();
  const label = resolveActiveLabel(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 lg:hidden">
      <button
        type="button"
        onClick={openMobile}
        aria-label="Open navigation"
        aria-controls="app-sidebar"
        aria-expanded={mobileOpen}
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors duration-150',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-none',
        )}
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
    </header>
  );
};
