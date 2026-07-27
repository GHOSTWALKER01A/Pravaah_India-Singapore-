import { Redirect } from 'expo-router';

import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';

/** Sends signed-out users to the OTP screen; renders children for authed users. */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Redirect href={ROUTES.AUTH.SEND_OTP} />;
  }
  return <>{children}</>;
}
