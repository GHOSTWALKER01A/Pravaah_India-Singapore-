'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from '@/app/context/auth-context';
import { ROUTES } from '@/features/routes';
import { isAdmin } from '@/lib/auth/roles';

/** Renders children only for an authenticated ADMIN; else redirects to login. */
export const AdminGuard = ({ children }: { children: React.ReactNode }) => {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const ok = isAdmin(user);

  useEffect(() => {
    if (loading || ok) return;
    // A non-admin token would ping-pong with GuestGuard, so clear it; a
    // signed-out visitor just goes to login.
    if (user) {
      logout();
    } else {
      router.replace(ROUTES.AUTH.LOGIN);
    }
  }, [ok, user, loading, logout, router]);

  if (loading || !ok) return null;

  return <>{children}</>;
};
