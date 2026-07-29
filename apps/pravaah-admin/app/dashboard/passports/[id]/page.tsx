'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { passportService } from '@/lib/api/passport/passport.service';

/** The backend enforces a substantive reason; mirrored so the button can be disabled. */
const MIN_REASON = 20;

type Intervention = 'revoke' | 'suspend' | 'resume';

/**
 * One credential, in full — the credential-risk view.
 *
 * Answers the three questions an investigator actually arrives with:
 *
 *  - "Is this passport live, and if not, why?" — status, revoke reason, and the audit trail.
 *  - "Which credential was live on this date?" — the supersede chain.
 *  - "Who has it been shown to?" — every presentation, INCLUDING the refused ones. A run of
 *    failures against one credential is the signal a theft attempt produces, and it is
 *    invisible if only successes are listed.
 *
 * What is absent, by design: the holder's claims. `claimKeys` shows that a nationality is
 * asserted; nothing here reveals which one. The backend never decrypts the disclosures for
 * this view, so the limit is structural rather than a UI choice.
 */
export default function PassportDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Intervention | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['passport', id],
    queryFn: () => passportService.getCredential(id),
    enabled: !!id,
  });

  const audit = useQuery({
    queryKey: ['passport-audit', id],
    queryFn: () => passportService.getAudit(id),
    enabled: !!id,
  });

  const intervene = useMutation({
    mutationFn: async ({
      action,
      text,
    }: {
      action: Intervention;
      text: string;
    }) => {
      if (action === 'revoke') return passportService.revoke(id, text);
      if (action === 'suspend') return passportService.suspend(id, text);
      return passportService.resume(id, text);
    },
    onSuccess: (result, variables) => {
      toast.success(
        result.changed
          ? variables.action === 'revoke'
            ? 'Revoked — every verifier will now reject it'
            : variables.action === 'suspend'
              ? 'Suspended — verifiers will reject it until the hold is lifted'
              : 'Hold lifted — the passport works again'
          : 'No change: it was already in that state',
      );
      setMode(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['passport', id] });
      void queryClient.invalidateQueries({ queryKey: ['passport-audit', id] });
      void queryClient.invalidateQueries({ queryKey: ['passports'] });
      void queryClient.invalidateQueries({ queryKey: ['passport-stats'] });
    },
    onError: (caught: Error) => toast.error(caught.message),
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (isError || !data) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        {(error as Error)?.message ?? 'Passport not found.'}
      </p>
    );
  }

  const live = data.status === 'ISSUED';
  const held = data.status === 'SUSPENDED';
  // Terminal: there is no un-revoke, because a credential a verifier already rejected must
  // never start passing again. The holder re-issues instead.
  const terminal = data.status === 'REVOKED' || data.status === 'EXPIRED';

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href={ROUTES.DASHBOARD.PASSPORTS}
        className="text-muted-foreground text-sm underline-offset-2 hover:underline"
      >
        ← All passports
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold">
            {data.credentialNumber}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {data.status} · holder {data.pravaahId ?? 'unknown'} · {data.country}
            {data.passportBound ? ' · bound to a verified passport' : ''}
          </p>
        </div>

        {!terminal && (
          <div className="flex gap-2">
            {live && (
              <Button variant="outline" onClick={() => setMode('suspend')}>
                Suspend
              </Button>
            )}
            {held && (
              <Button variant="outline" onClick={() => setMode('resume')}>
                Lift hold
              </Button>
            )}
            <Button variant="destructive" onClick={() => setMode('revoke')}>
              Revoke
            </Button>
          </div>
        )}
      </div>

      {/* The intervention form. A mandatory, substantive reason is the whole control: it is
          the only record of why someone's passport stopped working. */}
      {mode && (
        <div className="mt-6 rounded-lg border border-black/10 p-4 dark:border-white/10">
          <h2 className="text-sm font-medium">
            {mode === 'revoke'
              ? 'Revoke this passport'
              : mode === 'suspend'
                ? 'Place this passport on hold'
                : 'Lift the hold'}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {mode === 'revoke'
              ? 'Permanent. Every verifier will reject it immediately, including anyone the holder has already shared it with. They will need to issue a new one.'
              : mode === 'suspend'
                ? 'Reversible, and it flips the same status-list bit as a revocation — to a verifier both read “do not accept”. That is the correct fail-closed behaviour while an investigation is open.'
                : 'The passport starts working again immediately.'}
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why? At least 20 characters — this is the permanent record."
            className="mt-3 w-full rounded-md border border-black/10 bg-transparent p-2 text-sm dark:border-white/10"
          />
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant={mode === 'revoke' ? 'destructive' : 'default'}
              disabled={
                reason.trim().length < MIN_REASON || intervene.isPending
              }
              onClick={() =>
                intervene.mutate({ action: mode, text: reason.trim() })
              }
            >
              {intervene.isPending ? 'Working…' : 'Confirm'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setMode(null);
                setReason('');
              }}
            >
              Cancel
            </Button>
            {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
              <span className="text-muted-foreground text-xs">
                {MIN_REASON - reason.trim().length} more characters
              </span>
            )}
          </div>
        </div>
      )}

      {data.revokeReason && (
        <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-xs uppercase tracking-wide text-red-600 dark:text-red-400">
            Why it stopped working
          </p>
          <p className="mt-1 text-sm">{data.revokeReason}</p>
          {data.revokedAt && (
            <p className="text-muted-foreground mt-1 text-xs">
              {formatDateTime(data.revokedAt)}
            </p>
          )}
        </div>
      )}

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <Section title="Credential">
          <Row label="Type" value={data.vct} mono />
          <Row label="Issued" value={formatDateTime(data.issuedAt)} />
          <Row label="Expires" value={formatDateTime(data.expiresAt)} />
          <Row label="Data rails" value={data.dataRails.join(', ')} />
          <Row label="Device" value={data.deviceLabel ?? 'unlabelled'} />
        </Section>

        <Section title="Trust anchor">
          <Row label="Signed by" value={data.issuerKey.kid} mono />
          <Row
            label="Key state"
            value={
              data.issuerKey.retiredAt
                ? 'retired — this credential can no longer be verified'
                : data.issuerKey.isActive
                  ? 'active signing key'
                  : 'rotated, still published'
            }
          />
          <Row label="Status list" value={data.statusList.uri} mono />
          <Row
            label="List position"
            value={`index ${data.statusList.index} · v${data.statusList.version}`}
          />
        </Section>

        <Section title="Holder binding">
          {/* Identifies the DEVICE. This is what an investigation into a suspected credential
              theft needs, and it is public by construction — it travels in every credential. */}
          <Row label="Subject DID" value={data.subjectDid} mono wrap />
          <Row
            label="Key thumbprint"
            value={data.holderJwkThumbprint}
            mono
            wrap
          />
        </Section>

        <Section title="Score behind it">
          {data.score ? (
            <>
              <Row label="Band" value={data.score.band ?? '—'} />
              <Row
                label="Model"
                value={`${data.score.modelVersion.name} ${data.score.modelVersion.version}`}
              />
              <Row
                label="Confidence"
                value={
                  data.score.confidence !== null
                    ? data.score.confidence.toFixed(2)
                    : '—'
                }
              />
              <Row
                label="Computed"
                value={
                  data.score.computedAt
                    ? formatDateTime(data.score.computedAt)
                    : '—'
                }
              />
              <Row label="Score state" value={data.score.status} />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              The score row is gone — the credential is orphaned and should be revoked.
            </p>
          )}
        </Section>
      </div>

      {/* Claim NAMES only. Rendered as a reminder of what the console can and cannot see. */}
      <Section title={`Claims it carries (${data.claimKeys.length})`} className="mt-6">
        <div className="flex flex-wrap gap-1.5">
          {data.claimKeys.map((claim) => (
            <span
              key={claim}
              className="rounded border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/10"
            >
              {claim}
            </span>
          ))}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          Names, never values. The signed credential and its disclosures stay encrypted — this
          console can see that a nationality is asserted, not which one.
        </p>
      </Section>

      {(data.chain.supersedes || data.chain.supersededBy) && (
        <Section title="Re-issue chain" className="mt-6">
          {data.chain.supersedes && (
            <Row
              label="Replaced"
              value={
                <Link
                  href={ROUTES.DASHBOARD.PASSPORT_DETAIL(
                    data.chain.supersedes.id,
                  )}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {data.chain.supersedes.credentialNumber}
                </Link>
              }
            />
          )}
          {data.chain.supersededBy && (
            <Row
              label="Replaced by"
              value={
                <Link
                  href={ROUTES.DASHBOARD.PASSPORT_DETAIL(
                    data.chain.supersededBy.id,
                  )}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {data.chain.supersededBy.credentialNumber}
                </Link>
              }
            />
          )}
        </Section>
      )}

      {data.card && (
        <Section title="Companion card" className="mt-6">
          <Row label="Serial" value={data.card.cardSerial} mono />
          <Row label="Status" value={data.card.status} />
          <Row label="NFC tag" value={data.card.nfcWritten ? 'written' : 'not written'} />
          <Row
            label="Last used"
            value={
              data.card.lastVerifiedAt
                ? formatDateTime(data.card.lastVerifiedAt)
                : 'never'
            }
          />
        </Section>
      )}

      <div className="mt-8">
        <h2 className="text-lg font-medium">
          Presentations ({data.presentations.length})
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Including refused ones — a run of failures against one credential is what an attempted
          theft looks like.
        </p>
        {data.presentations.length === 0 ? (
          <p className="text-muted-foreground mt-4 text-sm">
            Never presented.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Verifier</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Claims shared</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.presentations.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs">
                      {formatDateTime(row.presentedAt)}
                    </TableCell>
                    <TableCell>
                      {row.verifier}
                      {row.verifierCountry ? ` · ${row.verifierCountry}` : ''}
                    </TableCell>
                    <TableCell className="text-xs">{row.channel}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.disclosedClaims.length === 0
                        ? 'none — proof of validity only'
                        : row.disclosedClaims.join(', ')}
                    </TableCell>
                    <TableCell
                      className={
                        row.valid
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }
                      title={row.failureReason ?? undefined}
                    >
                      {row.valid
                        ? row.holderVerified
                          ? 'accepted'
                          : 'accepted (no device proof)'
                        : 'refused'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-medium">Audit trail</h2>
        {audit.isLoading && (
          <p className="text-muted-foreground mt-2 text-sm">Loading…</p>
        )}
        {audit.data && audit.data.length === 0 && (
          <p className="text-muted-foreground mt-2 text-sm">No entries.</p>
        )}
        {audit.data && audit.data.length > 0 && (
          <ul className="mt-4 space-y-2">
            {audit.data.map((row) => (
              <li
                key={row.id}
                className="rounded-md border border-black/10 p-3 text-sm dark:border-white/10"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-muted-foreground text-xs">
                    {row.actorType} · {formatDateTime(row.createdAt)}
                  </span>
                </div>
                {row.metadata != null && (
                  <pre className="text-muted-foreground mt-2 overflow-x-auto text-xs">
                    {JSON.stringify(row.metadata, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-black/10 p-4 dark:border-white/10 ${className}`}
    >
      <h2 className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  wrap = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-right ${mono ? 'font-mono text-xs' : ''} ${
          wrap ? 'break-all' : ''
        }`}
      >
        {value}
      </span>
    </div>
  );
}
