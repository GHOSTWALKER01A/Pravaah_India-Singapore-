'use client';

import { AdminGuard } from '@/components/AdminGuard';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { DashboardTopbar } from '@/components/nav/dashboard-topbar';
import { SidebarProvider } from '@/components/nav/sidebar-context';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminGuard>
      <SidebarProvider>
        {/* `h-dvh`, not `h-screen`: on mobile Safari `100vh` includes the collapsing
            browser chrome, which pushes the bottom of the drawer and the account controls
            below the fold with no way to reach them. */}
        <div className="flex h-dvh overflow-hidden">
          <AppSidebar />
          {/* `min-w-0` is load-bearing. Without it a wide table — the ledger and
              reconciliation screens both have one — refuses to shrink below its content
              and shoves the sidebar off the left edge instead of scrolling itself. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <DashboardTopbar />
            <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
              {children}
            </main>
          </div>
        </div>
      </SidebarProvider>
    </AdminGuard>
  );
}
