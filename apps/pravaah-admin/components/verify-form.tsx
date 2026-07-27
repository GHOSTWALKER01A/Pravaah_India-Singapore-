'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';
import { useAuth } from '@/app/context/auth-context';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

export const VerifyForm = () => {
  const { verifyOtp, resendOtp } = useAuth();
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  // Start in cooldown — a code was just sent on the previous screen.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  // Guards the button + auto-submit-on-complete from both firing a verify.
  const busyRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const verify = useCallback(
    async (code: string) => {
      if (busyRef.current || code.length !== OTP_LENGTH) return;
      busyRef.current = true;
      setSubmitting(true);
      try {
        await verifyOtp(code);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Invalid or expired OTP',
        );
        setOtp(''); // reset the slots for another try
      } finally {
        setSubmitting(false);
        busyRef.current = false;
      }
    },
    [verifyOtp],
  );

  const onResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      await resendOtp();
      setOtp('');
      toast.success('A new code has been sent');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      // Surfaces the real reason (e.g. rate limit) instead of a silent 400.
      toast.error(
        error instanceof Error ? error.message : 'Could not resend the code',
      );
    } finally {
      setResending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void verify(otp);
      }}
      className="flex w-full max-w-sm flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Enter the 6-digit code</label>
        <InputOTP
          maxLength={OTP_LENGTH}
          value={otp}
          onChange={setOtp}
          onComplete={verify}
          disabled={submitting}
          autoFocus
        >
          <InputOTPGroup className="gap-2">
            {Array.from({ length: OTP_LENGTH }, (_, i) => (
              <InputOTPSlot key={i} index={i} className="h-11 rounded-md border" />
            ))}
          </InputOTPGroup>
        </InputOTP>
        <p className="text-muted-foreground text-xs">
          The code auto-fills from your SMS on supported browsers.
        </p>
      </div>

      <Button type="submit" disabled={submitting || otp.length !== OTP_LENGTH}>
        {submitting ? 'Verifying…' : 'Verify & sign in'}
      </Button>

      <button
        type="button"
        onClick={onResend}
        disabled={cooldown > 0 || resending}
        className="text-muted-foreground text-sm hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
      >
        {resending
          ? 'Resending…'
          : cooldown > 0
            ? `Resend OTP in ${cooldown}s`
            : 'Resend OTP'}
      </button>
    </form>
  );
};
