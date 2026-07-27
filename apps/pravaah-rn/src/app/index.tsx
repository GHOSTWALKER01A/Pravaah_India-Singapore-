import { Redirect } from 'expo-router';

import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';

/** Entry point — route to the app if signed in, otherwise to the OTP flow. */
export default function Index() {
  const { isAuthenticated } = useAuth();
  return (
    <Redirect href={isAuthenticated ? ROUTES.TABS.HOME : ROUTES.AUTH.SEND_OTP} />
  );
}
