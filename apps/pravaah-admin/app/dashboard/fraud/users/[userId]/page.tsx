'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  CaseStatusBadge,
  DecisionBadge,
  SeverityBadge,
  subjectLabel,
} from '@/components/fraud/badges';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';
import type { GraphNeighbourhood } from '@/lib/api/fraud/fraud.schema';

/**
 * One account's whole risk picture.
 *
 * ## Why this is one page and one request
 *
 * An analyst deciding whether to release somebody's money needs the devices, the cluster, the
 * past decisions and the other cases AT ONCE. Five endpoints would be five chances to read a
 * stale half of the picture — and the half you did not refresh is the half that changes the
 * decision.
 *
 * ## Why the graph is rendered as counts and a member list, not a diagram
 *
 * A force-directed graph looks impressive and answers no question an analyst actually has.
 * What they need to know is: how many accounts are transitively linked to this one, what KIND of
 * artefact links them, and which members score highest. Those are three numbers and a sorted
 * list, and a node diagram makes all three harder to read while adding a rendering library.
 *
 * `sharedKeyHash` is never returned by the server, so there is nothing here that could identify
 * WHICH device or payee is shared — only that something is. That is the privacy position the
 * mule graph is built on, and this page cannot break it because the data never arrives.
 */
export default function UserRiskPage() {
  const params = useParams<{ userId: string }>();
  const userId = params.userId;
  const queryClient = useQueryClient();

  const [note, setNote] = useState('');
  const [confirmingSuspend, setConfirmingSuspend] = useState(false);

  const profile = useQuery({
    queryKey: ['fraud-user', userId],
    queryFn: () => fraudAdminService.userProfile(userId),
  });

  const suspend = useMutation({
    mutationFn: (nextSuspended: boolean) =>
      fraudAdminService.setSuspended(userId, nextSuspended, note),
    onSuccess: (result) => {
      toast.success(
        result.isSuspended ? 'Account suspended' : 'Account restored',
      );
      setNote('');
      setConfirmingSuspend(false);
      void queryClient.invalidateQueries({ queryKey: ['fraud-user', userId] });
      void queryClient.invalidateQueries({ queryKey: ['fraud-cases'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (profile.isLoading) {
    return (
      <p className="text-muted-foreground text-sm">Loading this account…</p>
    );
  }

  const data = profile.data;
  if (!data?.user) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Could not load this account.
      </p>
    );
  }

  const { user, devices, assessments, cases, graph, recentEvents } = data;
  const noteTooShort = note.trim().length < 5;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {user.pravaahId ?? userId.slice(0, 8)}
          </h1>
          {user.isSuspended ? (
            <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950 dark:text-red-400">
              SUSPENDED
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {user.kycStatus} · {user.primaryCountry}
          </span>
        </div>
        <p className="text-muted-foreground text-sm">
          Joined {formatDateTime(user.createdAt)}
          {user.phone ? ` · ${user.phone}` : ''}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        {/* ── DEVICES ─────────────────────────────────────────────────────── */}
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">
            Devices
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              {devices.length}
            </span>
          </h2>

          {devices.length === 0 ? (
            /*
              No devices is a FINDING, not an empty state.

              Every action from this account has been scored `DEVICE_UNBOUND`, which means the
              ladder has been challenging them constantly — and it also means the SIM-swap and
              cooling-off layers have never applied. Worth saying, because an analyst reading a
              case on this account needs to know the device layer contributed nothing.
            */
            <p className="text-muted-foreground text-sm">
              No devices registered. Every action from this account is scored as coming
              from an unrecognised device, and the SIM-swap layer has never applied.
            </p>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => (
                <li key={device.id} className="border-b pb-2 last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">{device.platform}</span>
                    <span
                      className={`text-xs ${
                        device.status === 'ACTIVE'
                          ? 'text-green-600 dark:text-green-400'
                          : device.status === 'SUSPECTED_SWAP'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-muted-foreground'
                      }`}
                    >
                      {device.status}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-[11px]">
                    Last seen {formatDateTime(device.lastSeenAt)}
                    {device.integrity !== 'OK'
                      ? ` · integrity ${device.integrity}`
                      : ''}
                    {device.swapDetectedAt
                      ? ` · SIM change ${formatDateTime(device.swapDetectedAt)}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── THE GRAPH ───────────────────────────────────────────────────── */}
        <GraphPanel graph={graph} currentUserId={userId} />

        {/* ── CASES ───────────────────────────────────────────────────────── */}
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">
            Cases
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              {cases.length}
            </span>
          </h2>

          {cases.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No fraud case has ever been opened on this account.
            </p>
          ) : (
            <ul className="space-y-2">
              {cases.map((row) => (
                <li key={row.id} className="border-b pb-2 last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={ROUTES.DASHBOARD.FRAUD_CASE_DETAIL(row.id)}
                      className="text-sm underline-offset-2 hover:underline"
                    >
                      {formatDateTime(row.openedAt)}
                    </Link>
                    <span className="flex items-center gap-2">
                      <SeverityBadge severity={row.severity} />
                      <CaseStatusBadge status={row.status} />
                    </span>
                  </div>
                  <p className="text-muted-foreground truncate font-mono text-[10px]">
                    {row.reason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── RECENT DECISIONS ────────────────────────────────────────────── */}
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 font-medium">Recent decisions</h2>

          {assessments.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing scored yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {assessments.map((row) => (
                <li key={row.id} className="border-b pb-2 last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">
                      {subjectLabel(row.subjectType)}
                    </span>
                    <DecisionBadge decision={row.decision} />
                  </div>
                  <p className="text-muted-foreground text-[11px]">
                    {formatDateTime(row.computedAt)}
                  </p>
                  {/*
                    This projection carries REASONS but no score — it is the same shape the
                    customer sees. Deliberate: on this page the reasons are what an analyst
                    needs to cross-reference against the customer's own account of events, and
                    the arithmetic is one click away on the assessment itself.
                  */}
                  {row.reasons.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {row.reasons.map((reason) => (
                        <li
                          key={reason}
                          className="text-muted-foreground text-[11px]"
                        >
                          · {reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── THE DEVICE TIMELINE ───────────────────────────────────────────── */}
      <section className="rounded-lg border p-4">
        <h2 className="mb-3 font-medium">Device activity</h2>

        {recentEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm">No events recorded.</p>
        ) : (
          <ol className="space-y-1">
            {recentEvents.map((event, index) => (
              <li
                key={`${event.createdAt}-${index}`}
                className="flex flex-wrap items-baseline gap-3 text-xs"
              >
                <span className="text-muted-foreground w-40 shrink-0 font-mono">
                  {formatDateTime(event.createdAt)}
                </span>
                <span
                  className={`font-mono ${
                    event.type === 'SUSPECTED_SWAP' ||
                    event.type === 'INTEGRITY_FAIL'
                      ? 'text-red-600 dark:text-red-400'
                      : ''
                  }`}
                >
                  {event.type}
                </span>
                {event.geoHint ? (
                  <span className="text-muted-foreground">{event.geoHint}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── THE HEAVY CONTROL ─────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">
          {user.isSuspended ? 'Restore this account' : 'Suspend this account'}
        </h2>
        <p className="text-muted-foreground text-sm">
          {user.isSuspended
            ? 'Restoring lets this account send money, file claims, share data and register devices again.'
            : 'Suspending stops payments, claims, data sharing AND device registration — the risk engine treats it as a hard gate, so one flag covers every module.'}
        </p>

        <textarea
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            setConfirmingSuspend(false);
          }}
          rows={3}
          placeholder="Why. This is recorded against your name."
          className="w-full rounded-md border bg-transparent p-2 text-sm"
        />

        {confirmingSuspend ? (
          <div className="space-y-2 rounded-md border border-red-500/50 bg-red-50 p-3 dark:bg-red-950/30">
            <p className="text-sm font-medium">
              Suspend this account entirely?
            </p>
            <p className="text-muted-foreground text-xs">
              Every module refuses them until it is lifted. If a case is still open, resolve
              the case rather than suspending here — confirming fraud on a case suspends the
              account as part of the same decision and records why.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={suspend.isPending}
                onClick={() => suspend.mutate(true)}
              >
                {suspend.isPending ? 'Suspending…' : 'Yes, suspend'}
              </Button>
              <Button
                variant="outline"
                disabled={suspend.isPending}
                onClick={() => setConfirmingSuspend(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant={user.isSuspended ? 'default' : 'destructive'}
            disabled={noteTooShort || suspend.isPending}
            onClick={() => {
              if (user.isSuspended) {
                suspend.mutate(false);
                return;
              }
              setConfirmingSuspend(true);
            }}
          >
            {user.isSuspended ? 'Restore account' : 'Suspend account…'}
          </Button>
        )}
      </section>
    </div>
  );
}

/**
 * The link cluster around this account.
 *
 * Rendered as three figures and a member list rather than a node diagram — see the page
 * comment for why. The three figures are the ones the mule score is computed from, so an
 * analyst can see WHY the graph implicated this account rather than only that it did.
 */
function GraphPanel({
  graph,
  currentUserId,
}: {
  graph: GraphNeighbourhood;
  currentUserId: string;
}) {
  const queryClient = useQueryClient();

  const recompute = useMutation({
    mutationFn: () => fraudAdminService.recomputeGraph(),
    onSuccess: (result) => {
      toast.success(
        `Recomputed ${result.nodes} accounts across ${result.clusters} clusters`,
      );
      void queryClient.invalidateQueries({
        queryKey: ['fraud-user', currentUserId],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const others = graph.members.filter(
    (member) => member.userId !== currentUserId,
  );

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Link cluster</h2>
        {/*
          The mule score is only meaningful against the floor it is compared to.

          0.5 is where the `MULE_GRAPH` signal starts contributing, so a bare "0.43" would tell
          an analyst nothing about whether the graph affected this account's decisions. Stating
          the threshold is what makes the number readable.
        */}
        <span className="font-mono text-xs">
          mule score {graph.muleScore.toFixed(4)}
          <span className="text-muted-foreground">
            {graph.muleScore >= 0.5 ? ' · above the 0.50 floor' : ' · below the 0.50 floor'}
          </span>
        </span>
      </div>

      {graph.clusterId === null ? (
        <>
          <p className="text-muted-foreground text-sm">
            This account shares no identifiers with any other. The graph layer
            contributes nothing to its decisions.
          </p>
          {/*
            The recompute button is offered HERE specifically.

            An empty cluster has two very different causes — genuinely isolated, or the async
            job has not run since the edges were written — and an analyst cannot tell them
            apart. Being able to force the pass is what distinguishes "no ring" from "not
            computed yet".
          */}
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={recompute.isPending}
            onClick={() => recompute.mutate()}
          >
            {recompute.isPending ? 'Recomputing…' : 'Recompute the graph now'}
          </Button>
        </>
      ) : (
        <>
          <dl className="mb-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Cluster size</dt>
              <dd className="font-mono tabular-nums">{graph.clusterSize}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Linked accounts</dt>
              <dd className="font-mono tabular-nums">{others.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Edge kinds</dt>
              <dd className="font-mono tabular-nums">
                {graph.edgeTypes.length}
              </dd>
            </div>
          </dl>

          {graph.edgeTypes.length > 0 ? (
            <ul className="mb-3 flex flex-wrap gap-1">
              {graph.edgeTypes.map((edge) => (
                <li
                  key={edge.linkType}
                  className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                >
                  {edge.linkType} ×{edge.count}
                </li>
              ))}
            </ul>
          ) : null}

          {others.length > 0 ? (
            <ul className="space-y-1">
              {/*
                Sorted by mule score server-side, so the most implicated members lead.

                On a fan-in ring the top rows are the collection accounts, which is where an
                analyst starts — the twenty payers behind them are victims more often than
                participants.
              */}
              {others.slice(0, 12).map((member) => (
                <li
                  key={member.userId}
                  className="flex items-baseline justify-between gap-3 text-xs"
                >
                  <Link
                    href={ROUTES.DASHBOARD.FRAUD_USER(member.userId)}
                    className="font-mono underline-offset-2 hover:underline"
                  >
                    {member.userId.slice(0, 8)}
                  </Link>
                  <span className="text-muted-foreground font-mono tabular-nums">
                    {member.muleScore.toFixed(2)} · degree {member.degree}
                  </span>
                </li>
              ))}
              {others.length > 12 ? (
                <li className="text-muted-foreground text-[11px]">
                  and {others.length - 12} more in this cluster
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
