'use client';

import { GuestGuard } from '@/components/GuestGuard';
import { LoginForm } from '@/components/login-form';

export default function LoginPage() {
  return (
    <GuestGuard>
      <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Pravaah Admin</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Sign in to the operations console
          </p>
        </div>
        <LoginForm />
      </main>
    </GuestGuard>
  );
}
