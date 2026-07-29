import { createContext, useContext, useState, type ReactNode } from 'react';

import {
  authService,
  tokenManager,
  userService,
  type SendOtpRequest,
} from '@/api';
import {
  forgetSession,
  saveSession,
} from '@/features/security/session-vault';

interface AuthUser {
  /** Internal row id — needed by the API, never rendered. */
  userId: string;
  /** The user's permanent public identity, `PVH-XXXX-XXXX-XXXX`. */
  pravaahId: string;
  kycStatus: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  /** The phone number an OTP was last sent to, if any. */
  pending: SendOtpRequest | null;
  isAuthenticated: boolean;
  sendOtp: (identifier: SendOtpRequest) => Promise<void>;
  resendOtp: () => Promise<void>;
  verifyOtp: (otp: string) => Promise<void>;
  /**
   * Come back from a persisted session. Called by the launch gate, never by a screen.
   *
   * Takes the token the OS released plus the user id the vault recorded, and hydrates the
   * profile from `/users/me`. Throws if the token is refused or the identities disagree.
   */
  restoreFrom: (refreshToken: string, expectedUserId: string) => Promise<void>;
  setKycStatus: (status: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Nothing here is hand-memoised.
 *
 * The React Compiler (`experiments.reactCompiler` in app.json) memoises the provider value and
 * every handler on it, which is the case it is best at: a context value is re-created on each
 * render and drags every consumer with it. None of these functions is an effect dependency
 * anywhere, so there is no correctness argument for keeping the hooks — see `use-wallet.ts` for
 * where that argument does apply.
 *
 * Dropping the `useCallback`s also fixed a latent staleness: `resendOtp` and `verifyOtp` closed
 * over `pending`, so a call made in the same tick that `pending` changed used the previous value.
 * Plain functions read it at call time.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [pending, setPending] = useState<SendOtpRequest | null>(null);

  const sendOtp = async (identifier: SendOtpRequest) => {
    await authService.sendOtp(identifier);
    setPending(identifier);
  };

  const resendOtp = async () => {
    if (!pending) throw new Error('No pending verification');
    await authService.resendOtp(pending);
  };

  const verifyOtp = async (otp: string) => {
    if (!pending) throw new Error('Session expired — request a new code');
    const data = await authService.verifyOtp({ ...pending, otp });
    setUser({
      userId: data.userId,
      pravaahId: data.pravaahId,
      kycStatus: data.kycStatus,
    });
    setPending(null);

    /**
     * Persist the session so the NEXT launch asks for a fingerprint rather than another code.
     *
     * Not awaited for its result, and it cannot throw — `saveSession` reports failure by
     * returning false. Both properties matter here: this is the last line of a completed
     * sign-in, and letting a keystore problem reject the promise would discard an
     * authentication the user has already passed. The worst case is a device that cannot
     * persist, and the honest consequence is that it asks for a code again next time.
     */
    void saveSession({
      refreshToken: data.refreshToken,
      userId: data.userId,
    });
  };

  /**
   * Come back from a persisted session, after the OS has released the token.
   *
   * The profile is re-fetched rather than persisted alongside the token, and that is not
   * laziness — `kycStatus` changes server-side while the app is closed, so a stored copy would
   * put a user who completed KYC on a web link back onto the "verify your identity" screen with
   * no way to escape it. The token is the only thing worth keeping; everything else is derived.
   *
   * `userId` from the vault is used only as a CROSS-CHECK. The server's answer wins, because the
   * server is the one that knows whose token it just accepted — trusting the stored value would
   * mean a tampered vault could relabel a session.
   */
  const restoreFrom = async (refreshToken: string, expectedUserId: string) => {
    await authService.restore(refreshToken);
    const me = await userService.me();

    if (me.id !== expectedUserId) {
      /**
       * The token belongs to a different account than the vault claimed.
       *
       * Not reachable through any normal path, which is exactly why it is handled: if it ever
       * happens, something has rewritten the keystore, and continuing would attach one person's
       * session to another person's stored identity. Everything is dropped and they sign in.
       */
      tokenManager.clear();
      await forgetSession();
      throw new Error('Session mismatch — please sign in again');
    }

    setUser({
      userId: me.id,
      pravaahId: me.pravaahId,
      kycStatus: me.kycStatus,
    });
    setPending(null);
  };

  const setKycStatus = (status: string) => {
    setUser((prev) => (prev ? { ...prev, kycStatus: status } : prev));
  };

  /**
   * Sign out, and mean it.
   *
   * `forgetSession` is the load-bearing half. Clearing only the in-memory tokens would leave the
   * persisted refresh token in the keystore, so the next launch would offer to unlock straight
   * back into the account the user just signed out of — a sign-out button that signs nobody out.
   * On a shared or handed-on phone that is the whole problem it exists to solve.
   */
  const logout = () => {
    authService.logout();
    void forgetSession();
    setUser(null);
    setPending(null);
  };

  const value: AuthContextValue = {
    user,
    pending,
    isAuthenticated: Boolean(user) && tokenManager.isAuthenticated(),
    sendOtp,
    resendOtp,
    verifyOtp,
    restoreFrom,
    setKycStatus,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
