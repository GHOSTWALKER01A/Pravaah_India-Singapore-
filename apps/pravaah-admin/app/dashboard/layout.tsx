'use client';

import { AppSidebar } from '@/components/app-sidebar';
import { AdminGuard } from '@/components/AdminGuard';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminGuard>
      <div className="flex h-screen">
        <AppSidebar />
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
    </AdminGuard>
  );
}
