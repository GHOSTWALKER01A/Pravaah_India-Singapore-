import { Redirect } from 'expo-router';

import { ROUTES } from '@/constants/routes.constants';
import { useAuth } from '@/context/auth-context';
import { UnlockScreen } from '@/features/security/screens';
import { useUnlock } from '@/features/security/use-unlock';

/**
 * Entry point, and the launch gate.
 *
 * ## What changed here, and why it matters more than it looks
 *
 * This used to be a two-line redirect: signed in → the app, otherwise → the OTP flow. Since nothing
 * persisted a session, "otherwise" was EVERY cold start, and a returning user typed an SMS code on
 * every single launch.
 *
 * That was not a security control, though it wore one's clothes. It was actively harmful: an OTP on
 * every launch trains a user to expect a code, type it without reading it, and treat the arrival of
 * one as routine — which is precisely the conditioning every OTP phishing script depends on. A
 * relaunch that asks for a fingerprint is both less friction AND a stronger factor.
 *
 * ## Why the gate lives at the ROOT and not inside `(app)`
 *
 * Because it replaces the sign-in screen for a returning user, so it has to occupy the
 * unauthenticated position in the tree. Putting it inside the authenticated group would mount that
 * group's layout — and every data hook hanging off it — with a session that has not been unlocked
 * yet, firing a wallet fetch and a KYC poll against a token the app does not hold.
 *
 * ## Why `isAuthenticated` short-circuits before the gate
 *
 * A user navigating back to `/` inside a live session must not be asked to unlock again. The gate is
 * for cold starts; treating an in-session visit as one would raise the OS prompt on a back gesture.
 */
export default function Index() {
  const { isAuthenticated, restoreFrom } = useAuth();

  const gate = useUnlock({ restore: restoreFrom });

  /**
   * Checked FIRST, and it covers two cases that look different and behave identically: a session
   * that was live all along, and one the gate has just restored. In both, `isAuthenticated` is true
   * and the answer is the same redirect — so the gate's `restored` phase needs no separate branch,
   * and giving it one would be a second route to a single destination.
   */
  if (isAuthenticated) return <Redirect href={ROUTES.TABS.HOME} />;

  /**
   * `null` while the marker is being read.
   *
   * One frame, but the wrong thing here is visible and confusing: rendering the phone-number screen
   * first and replacing it once the marker resolves shows a returning user a sign-in form that
   * vanishes under them. The splash is still up at this point, so nothing flashes.
   */
  if (gate.phase === 'checking') return null;

  if (gate.phase === 'locked' || gate.phase === 'unlocking') {
    return <UnlockScreen {...gate} />;
  }

  return <Redirect href={ROUTES.AUTH.SEND_OTP} />;
}
