import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { authService, tokenManager, type SendOtpRequest } from '@/api';

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
  setKycStatus: (status: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [pending, setPending] = useState<SendOtpRequest | null>(null);

  const sendOtp = useCallback(async (identifier: SendOtpRequest) => {
    await authService.sendOtp(identifier);
    setPending(identifier);
  }, []);

  const resendOtp = useCallback(async () => {
    if (!pending) throw new Error('No pending verification');
    await authService.resendOtp(pending);
  }, [pending]);

  const verifyOtp = useCallback(
    async (otp: string) => {
      if (!pending) throw new Error('Session expired — request a new code');
      const data = await authService.verifyOtp({ ...pending, otp });
      setUser({
        userId: data.userId,
        pravaahId: data.pravaahId,
        kycStatus: data.kycStatus,
      });
      setPending(null);
    },
    [pending],
  );

  const setKycStatus = useCallback((status: string) => {
    setUser((prev) => (prev ? { ...prev, kycStatus: status } : prev));
  }, []);

  const logout = useCallback(() => {
    authService.logout();
    setUser(null);
    setPending(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      pending,
      isAuthenticated: Boolean(user) && tokenManager.isAuthenticated(),
      sendOtp,
      resendOtp,
      verifyOtp,
      setKycStatus,
      logout,
    }),
    [user, pending, sendOtp, resendOtp, verifyOtp, setKycStatus, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
