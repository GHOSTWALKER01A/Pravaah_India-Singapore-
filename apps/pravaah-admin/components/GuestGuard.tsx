'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useAuth } from '@/app/context/auth-context';
import { ROUTES } from '@/features/routes';
import { isAdmin } from '@/lib/auth/roles';

/** Renders children only when there is no admin session; admins go to the dashboard. */
export const GuestGuard = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (loading) return;
    // Only bounce confirmed admins away from login. A non-admin (or absent)
    // session renders the login page instead of redirecting — same predicate
    // as AdminGuard, so the two can never disagree and loop.
    if (isAdmin(user)) {
      router.replace(ROUTES.DASHBOARD.ROOT);
    } else {
      setChecked(true);
    }
  }, [user, loading, router]);

  if (!checked) return null;

  return <>{children}</>;
};
