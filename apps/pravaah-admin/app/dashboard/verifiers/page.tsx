'use client';

import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/helper/date-convertor';
import { passportService } from '@/lib/api/passport/passport.service';
import type { PartnerCreated } from '@/lib/api/passport/passport.schema';

/**
 * Registered verifiers — who is allowed to ask a Pravaah holder for claims.
 *
 * The `audience` is the load-bearing field on this page, and worth understanding before
 * registering anyone: it is the identifier that must appear as the `aud` inside every key
 * binding proof made out to that verifier. Binding a presentation to ONE audience is what
 * stops a presentation captured at one lender being replayed at another — so an audience is
 * immutable once issued, and the backend refuses to reassign it.
 *
 * The API key is shown exactly once, here, at registration. Only its hash is stored: a key we
 * could re-read is a key that leaks with the database.
 */
export default function VerifiersPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    audience: '',
    contactEmail: '',
    country: '',
  });
  /** Held in component state ONLY. Never re-fetchable — this is the single showing. */
  const [issued, setIssued] = useState<PartnerCreated | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['verifiers'],
    queryFn: () => passportService.listPartners(),
  });

  const register = useMutation({
    mutationFn: () =>
      passportService.registerPartner({
        name: form.name.trim(),
        audience: form.audience.trim(),
        ...(form.contactEmail.trim()
          ? { contactEmail: form.contactEmail.trim() }
          : {}),
        ...(form.country.trim() ? { country: form.country.trim() } : {}),
      }),
    onSuccess: (result) => {
      setIssued(result);
      setCreating(false);
      setForm({ name: '', audience: '', contactEmail: '', country: '' });
      void queryClient.invalidateQueries({ queryKey: ['verifiers'] });
    },
    onError: (caught: Error) => toast.error(caught.message),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => passportService.deactivatePartner(id),
    onSuccess: () => {
      toast.success('Verifier deactivated — their key no longer works');
      void queryClient.invalidateQueries({ queryKey: ['verifiers'] });
    },
    onError: (caught: Error) => toast.error(caught.message),
  });

  const canSubmit =
    form.name.trim().length >= 2 && /^[a-z0-9][a-z0-9._:-]*$/.test(form.audience.trim());

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Verifiers</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Organisations allowed to open verification requests against Pravaah holders. Each
            gets one immutable audience, which is what binds a presentation to them alone.
          </p>
        </div>
        {!creating && !issued && (
          <Button onClick={() => setCreating(true)}>Register a verifier</Button>
        )}
      </div>

      {/* The one and only showing of the API key. Deliberately hard to dismiss by accident. */}
      {issued && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
          <h2 className="text-sm font-medium">
            {issued.name} registered — copy this key now
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{issued.warning}</p>
          <pre className="mt-3 overflow-x-auto rounded-md border border-black/10 p-3 font-mono text-xs dark:border-white/10">
            {issued.apiKey}
          </pre>
          <p className="text-muted-foreground mt-2 text-xs">
            Sent as the <code>x-pravaah-partner-key</code> header. Audience:{' '}
            <code>{issued.audience}</code>
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(issued.apiKey)
                  .then(() => toast.success('Key copied'))
                  .catch(() => toast.error('Could not copy — select it manually'));
              }}
            >
              Copy key
            </Button>
            <Button variant="outline" onClick={() => setIssued(null)}>
              I have stored it
            </Button>
          </div>
        </div>
      )}

      {creating && (
        <div className="mt-6 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="text-sm font-medium">Register a verifier</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Labelled label="Name" hint="Shown to holders in their share history.">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Acme Bank"
                className="w-full rounded-md border border-black/10 bg-transparent p-2 text-sm dark:border-white/10"
              />
            </Labelled>
            <Labelled
              label="Audience"
              hint="Immutable. Lowercase slug or URI — it goes inside every proof made out to them."
            >
              <input
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
                placeholder="acme-bank"
                className="w-full rounded-md border border-black/10 bg-transparent p-2 font-mono text-sm dark:border-white/10"
              />
            </Labelled>
            <Labelled label="Contact email" hint="Optional.">
              <input
                value={form.contactEmail}
                onChange={(e) =>
                  setForm({ ...form, contactEmail: e.target.value })
                }
                placeholder="risk@acme.example"
                className="w-full rounded-md border border-black/10 bg-transparent p-2 text-sm dark:border-white/10"
              />
            </Labelled>
            <Labelled label="Country" hint="ISO alpha-2. Audit context only.">
              <input
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
                placeholder="SG"
                maxLength={2}
                className="w-full rounded-md border border-black/10 bg-transparent p-2 text-sm uppercase dark:border-white/10"
              />
            </Labelled>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              disabled={!canSubmit || register.isPending}
              onClick={() => register.mutate()}
            >
              {register.isPending ? 'Registering…' : 'Register'}
            </Button>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            {form.audience.trim().length > 0 && !canSubmit && (
              <span className="text-muted-foreground text-xs">
                Audience must be a lowercase slug or URI.
              </span>
            )}
          </div>
        </div>
      )}

      {isLoading && (
        <p className="text-muted-foreground mt-6 text-sm">Loading…</p>
      )}
      {isError && (
        <p className="mt-6 text-sm text-red-600 dark:text-red-400">
          {(error as Error).message}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="text-muted-foreground mt-6 text-sm">
          No verifiers yet. Until one is registered, nobody can call{' '}
          <code className="text-xs">/verify</code> — the endpoint requires a partner key so the
          audience in a proof cannot be self-declared.
        </p>
      )}

      {data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Verifier</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Requests</TableHead>
                <TableHead>Shares seen</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((partner) => (
                <TableRow key={partner.id}>
                  <TableCell>
                    {partner.name}
                    {!partner.isActive && (
                      <span className="text-muted-foreground ml-2 text-[10px] uppercase tracking-wide">
                        inactive
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {partner.audience}
                  </TableCell>
                  <TableCell className="text-xs">
                    {partner.country ?? '—'}
                  </TableCell>
                  <TableCell>{partner.requestCount}</TableCell>
                  <TableCell>{partner.presentationCount}</TableCell>
                  <TableCell className="text-xs">
                    {partner.lastUsedAt
                      ? formatDateTime(partner.lastUsedAt)
                      : 'never'}
                  </TableCell>
                  <TableCell>
                    {partner.isActive && (
                      <Button
                        variant="outline"
                        disabled={deactivate.isPending}
                        onClick={() => deactivate.mutate(partner.id)}
                      >
                        Deactivate
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-muted-foreground mt-6 text-xs">
        Deactivating stops the key working but keeps the row. Their past presentations appear in
        holders&apos; share histories, and deleting the verifier would turn &ldquo;Acme Bank saw
        your score band&rdquo; into an opaque string in the one place a user goes to understand
        what they shared.
      </p>
    </div>
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-muted-foreground mt-0.5 block text-xs">{hint}</span>
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}
