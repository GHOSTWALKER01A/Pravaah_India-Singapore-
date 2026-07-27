'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useAuth } from '@/app/context/auth-context';
import { ROUTES } from '@/features/routes';
import { cn } from '@/lib/utils/utils';

const NAV = [
  { label: 'Overview', href: ROUTES.DASHBOARD.ROOT },
  { label: 'KYC Review', href: ROUTES.DASHBOARD.KYC },
  { label: 'Consents', href: ROUTES.DASHBOARD.CONSENT },
  // M2 — model risk. Kept as two entries because they answer different
  // questions: "is the model fit to ship?" and "why did this person get 728?".
  { label: 'Models & Fairness', href: ROUTES.DASHBOARD.MODELS },
  { label: 'Issued Scores', href: ROUTES.DASHBOARD.SCORES },
];

export const AppSidebar = () => {
  const pathname = usePathname();
  const { logout } = useAuth();

  return (
    <aside className="flex h-full w-60 flex-col border-r border-black/10 p-4 dark:border-white/10">
      <div className="mb-6 px-2 text-lg font-semibold">Pravaah Admin</div>
      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-black/5 font-medium dark:bg-white/10'
                  : 'text-zinc-600 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <button
        onClick={logout}
        className="rounded-md px-3 py-2 text-left text-sm text-zinc-600 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5"
      >
        Sign out
      </button>
    </aside>
  );
};
