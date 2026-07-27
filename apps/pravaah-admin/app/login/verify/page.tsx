'use client';

import { GuestGuard } from '@/components/GuestGuard';
import { VerifyForm } from '@/components/verify-form';

export default function VerifyPage() {
  return (
    <GuestGuard>
      <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Verify it&apos;s you</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Enter the code we sent to your phone or email
          </p>
        </div>
        <VerifyForm />
      </main>
    </GuestGuard>
  );
}
