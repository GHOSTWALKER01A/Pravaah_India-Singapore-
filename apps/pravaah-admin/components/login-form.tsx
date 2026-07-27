'use client';

import { useState } from 'react';

import { useAuth } from '@/app/context/auth-context';
import { Select } from '@/components/ui/select';
import { PhoneLoginSchema } from '@/lib/auth/auth.schema';

export const LoginForm = () => {
  const { login } = useAuth();
  const [countryCode, setCountryCode] = useState('+91');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isValid = PhoneLoginSchema.safeParse({ phone, countryCode }).success;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const r = PhoneLoginSchema.safeParse({ phone, countryCode });
    if (!r.success) {
      setError(r.error.issues[0]?.message ?? 'Invalid phone number');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await login(r.data);
    } catch {
      // login() already surfaces a toast; keep the form interactive.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Phone number</label>
        <div className="flex gap-2">
          <Select
            aria-label="Country dialling code"
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="w-28 shrink-0"
          >
            <option value="+91">🇮🇳 +91</option>
            <option value="+65">🇸🇬 +65</option>
          </Select>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            required
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value.replace(/\D/g, ''));
              if (error) setError(null);
            }}
            placeholder="98765 43210"
            aria-invalid={Boolean(error)}
            className="flex-1 rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 aria-invalid:border-red-500 dark:border-white/15 dark:focus:border-white/40"
          />
        </div>
      </div>

      {error ? <p className="text-xs text-red-500">{error}</p> : null}

      <button
        type="submit"
        disabled={submitting || !isValid}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
      >
        {submitting ? 'Sending OTP…' : 'Send OTP'}
      </button>
    </form>
  );
};
