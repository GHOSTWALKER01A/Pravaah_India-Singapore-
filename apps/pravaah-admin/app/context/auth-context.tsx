'use client';

import { useRouter } from 'next/navigation';
import React, { createContext, useContext, useEffect, useState } from 'react';

import { toast } from 'sonner';

import { ROUTES } from '@/features/routes';
import { authService } from '@/lib/auth/auth.service';
import type {
  AdminProfile,
  SendOtpRequest,
  VerifyOtpRequest,
} from '@/lib/auth/auth.schema';

interface AuthContextType {
  user: AdminProfile | null;
  loading: boolean;
  login: (request: SendOtpRequest) => Promise<void>;
  verifyOtp: (otp: string) => Promise<void>;
  resendOtp: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();
  const [user, setUser] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const persistTokens = (accessToken: string, refreshToken: string) => {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    document.cookie = `accessToken=${accessToken}; path=/;`;
  };

  const login = async (request: SendOtpRequest) => {
    try {
      await authService.sendOtp(request);
      // Persist the identifier so the verify/resend steps can rebuild it.
      localStorage.setItem('phone', request.phone);
      localStorage.setItem('countryCode', request.countryCode);
      router.push(ROUTES.AUTH.VERIFY_OTP);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to send OTP',
      );
      throw error;
    }
  };

  // Rebuild the pending OTP identifier (phone) from storage.
  const pendingIdentity = (): SendOtpRequest => {
    const phone = localStorage.getItem('phone');
    const countryCode = localStorage.getItem('countryCode');
    if (!phone || !countryCode) throw new Error('Session expired');
    return { phone, countryCode };
  };

  const verifyOtp = async (otp: string) => {
    const request: VerifyOtpRequest = { ...pendingIdentity(), otp };

    // The backend only returns a session for an active admin (else 403), so we
    // trust the returned profile/role rather than re-deriving it from the JWT.
    const { admin, accessToken, refreshToken } =
      await authService.verifyOtp(request);
    persistTokens(accessToken, refreshToken);
    setUser(admin);
    router.push(ROUTES.DASHBOARD.ROOT);
  };

  const resendOtp = async () => {
    await authService.resendOtp(pendingIdentity());
  };

  const logout = () => {
    if (typeof window === 'undefined') return;
    localStorage.clear();
    document.cookie =
      'accessToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;';
    setUser(null);
    router.replace(ROUTES.AUTH.LOGIN);
  };

  // On load, restore the session from the backend (validates the token AND
  // resolves the admin role — the source of truth, unlike the raw JWT claims).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('accessToken');
    if (!token) {
      setLoading(false);
      return;
    }
    authService
      .me()
      .then(setUser)
      .catch(() => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, login, verifyOtp, resendOtp, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
