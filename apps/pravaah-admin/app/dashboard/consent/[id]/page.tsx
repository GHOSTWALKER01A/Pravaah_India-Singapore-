'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';

import { StatusBadge } from '@/components/kyc/status-badge';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import type { ConsentAuditRow } from '@/lib/api/consent/consent.schema';
import { consentService } from '@/lib/api/consent/consent.service';

export default function ConsentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const consent = useQuery({
    queryKey: ['consent', id],
    queryFn: () => consentService.getConsent(id),
    enabled: Boolean(id),
  });

  const audit = useQuery({
    queryKey: ['consent-audit', id],
    queryFn: () => consentService.getAudit(id),
    enabled: Boolean(id),
  });

  if (consent.isLoading)
    return <p className="text-sm text-zinc-500">Loading…</p>;
  if (consent.isError)
    return (
      <p className="text-sm text-red-500">
        {consent.error instanceof Error
          ? consent.error.message
          : 'Failed to load consent'}
      </p>
    );
  const data = consent.data;
  if (!data) return null;

  const session = data.sessions[0];
  const coverage =
    session?.fipTotal && session.fipTotal > 0
      ? Math.round((session.fipCompleted / session.fipTotal) * 100)
      : null;

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href={ROUTES.DASHBOARD.CONSENT}
            className="text-muted-foreground text-xs hover:underline"
          >
            ← Consent estate
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{data.purpose}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            <span className="font-mono">{data.vua}</span> ·{' '}
            <span className="uppercase">{data.aaProvider}</span>
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      {/* Consent */}
      <Section title="Consent">
        <Field label="Status" value={<StatusBadge status={data.status} />} />
        <Field label="Purpose code" value={data.purposeCode} />
        <Field label="Consent mode" value={data.consentMode} />
        <Field label="Fetch type" value={data.fetchType} />
        <Field
          label="Artefact signature"
          value={
            data.artefactVerified ? (
              <span className="text-green-600 dark:text-green-400">
                Verified
              </span>
            ) : (
              'Unverified'
            )
          }
        />
        <Field label="FI types" value={data.fiTypes.join(', ')} />
        <Field
          label="Data range"
          value={`${data.dataRangeFrom.slice(0, 10)} → ${data.dataRangeTo.slice(0, 10)}`}
        />
        <Field
          label="Data-life"
          value={
            data.dataLifeUnit === 'INF'
              ? 'Until revoked'
              : `${data.dataLifeValue} ${data.dataLifeUnit.toLowerCase()}`
          }
        />
        <Field label="Approval expiry" value={formatDateTime(data.consentExpiry)} />
        <Field label="Created" value={formatDateTime(data.createdAt)} />
        <Field label="Activated" value={formatDateTime(data.activatedAt)} />
        <Field label="Revoked" value={formatDateTime(data.revokedAt)} />
        <Field label="Retention until" value={formatDateTime(data.expiresAt)} />
      </Section>

      {/* Data session */}
      <Section title="Latest data session">
        {session ? (
          <>
            <Field
              label="Status"
              value={<StatusBadge status={session.status} />}
            />
            <Field
              label="Coverage"
              value={
                coverage !== null
                  ? `${coverage}% (${session.fipCompleted}/${session.fipTotal} FIPs)`
                  : '—'
              }
            />
            <Field
              label="Feature sets stored"
              value={String(data.featuresAvailable)}
            />
            <Field label="Requested" value={formatDateTime(session.requestedAt)} />
            <Field label="Completed" value={formatDateTime(session.completedAt)} />
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            No data session yet — the user hasn&apos;t approved, or the fetch
            hasn&apos;t started.
          </p>
        )}
      </Section>

      {/* Audit trail */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-500">
          Audit trail ({audit.data?.length ?? 0})
        </h2>
        {audit.isLoading ? (
          <p className="text-muted-foreground mt-2 text-sm">Loading…</p>
        ) : !audit.data || audit.data.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No audit events recorded.
          </p>
        ) : (
          <ol className="mt-3 space-y-3 border-l border-black/10 pl-4 dark:border-white/10">
            {audit.data.map((row: ConsentAuditRow) => (
              <li key={row.id} className="relative">
                <span className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full bg-zinc-400" />
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm font-medium">
                    {row.action}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(row.createdAt)}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  {row.actorType}
                  {row.actorId ? ` · ${row.actorId.slice(0, 8)}…` : ''}
                  {row.ipAddress ? ` · ${row.ipAddress}` : ''}
                </div>
                {row.metadata != null &&
                Object.keys(row.metadata as object).length > 0 ? (
                  <pre className="text-muted-foreground mt-1 overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/5">
                    {JSON.stringify(row.metadata, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-500">{title}</h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-black/10 p-4 text-sm sm:grid-cols-2 dark:border-white/10">
        {children}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="wrap-break-word text-right font-medium">{value}</dd>
    </div>
  );
}
