'use client';

import Link from 'next/link';

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/app/context/auth-context';
import { ROUTES } from '@/features/routes';
import { scoringService } from '@/lib/api/scoring/scoring.service';

/**
 * Overview — the operational front page.
 *
 * The M2 panel leads with the two facts that can be actively wrong right now:
 * whether a model is active at all (no active model means every score request
 * fails), and whether the score distribution has drifted away from the population
 * the active model was audited against. Everything else is a link.
 */
export default function DashboardPage() {
  const { user } = useAuth();

  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => scoringService.listModels(),
  });
  const drift = useQuery({
    queryKey: ['drift'],
    queryFn: () => scoringService.getDrift(),
  });

  const active = models.data?.find((m) => m.isActive);
  const unaudited = (models.data ?? []).filter(
    (m) => !m.fairnessPassed && !m.isActive,
  );

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">Overview</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Signed in as {user?.email ?? 'admin'}
        {user?.role ? ` · ${user.role}` : ''}.
      </p>

      {/* ── M2: the two things that can be wrong right now ────────────────── */}
      <section className="mt-8 rounded-lg border border-black/10 p-6 dark:border-white/10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-medium">Reputation engine</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Model registry, the fairness activation gate, and every issued score
              (M2).
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href={ROUTES.DASHBOARD.MODELS}
              className="bg-foreground text-background rounded-md px-4 py-2 text-sm font-medium"
            >
              Models &amp; fairness
            </Link>
            <Link
              href={ROUTES.DASHBOARD.SCORES}
              className="border-input rounded-md border px-4 py-2 text-sm font-medium"
            >
              Issued scores
            </Link>
          </div>
        </div>

        {/* No active model is not a warning, it is an outage: every compute 503s. */}
        {models.isSuccess && !active && (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/5 p-3">
            <div className="text-sm font-semibold text-red-700 dark:text-red-400">
              No active model — scoring is down
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              Every score request will fail until a fairness-audited version is
              activated.
            </p>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Active model"
            value={active ? `v${active.version}` : '— none —'}
            hint={
              active
                ? `${active.runtime} · ${active.scoreCount ?? 0} scores issued`
                : 'activate one to start scoring'
            }
            tone={active ? 'ok' : 'bad'}
          />
          <Stat
            label="Fairness gate"
            value={
              models.isSuccess
                ? `${(models.data ?? []).filter((m) => m.fairnessPassed).length}/${models.data?.length ?? 0} passed`
                : '—'
            }
            hint={
              unaudited.length
                ? `${unaudited.length} version${unaudited.length === 1 ? '' : 's'} cannot be activated`
                : 'all registered versions audited'
            }
            tone={unaudited.length ? 'warn' : 'ok'}
          />
          <Stat
            label="Score drift (24h vs prior week)"
            value={
              drift.data
                ? `${drift.data.meanShift > 0 ? '+' : ''}${drift.data.meanShift} pts`
                : '—'
            }
            hint={
              drift.data
                ? drift.data.alert
                  ? (drift.data.reasons[0] ?? 'distribution shifted')
                  : `stable · n=${drift.data.recent.count} recent`
                : 'loading'
            }
            tone={drift.data?.alert ? 'warn' : 'ok'}
          />
        </div>

        {drift.data?.alert && (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              Score distribution has drifted
            </div>
            <ul className="text-muted-foreground mt-1 space-y-0.5 text-sm">
              {drift.data.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              A shifting distribution under an unchanged model means the incoming
              population changed — which is when a model quietly stops being the
              model that was audited.
            </p>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-black/10 p-6 dark:border-white/10">
        <h2 className="text-base font-medium">KYC review queue</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Claim open cases and record approve / reject decisions (M0).
        </p>
        <Link
          href={ROUTES.DASHBOARD.KYC}
          className="bg-foreground text-background mt-4 inline-block rounded-md px-4 py-2 text-sm font-medium"
        >
          Open review queue
        </Link>
      </section>

      <section className="mt-6 rounded-lg border border-black/10 p-6 dark:border-white/10">
        <h2 className="text-base font-medium">Consent estate</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Oversee Account Aggregator data-sharing consents and their audit trails
          (M1).
        </p>
        <Link
          href={ROUTES.DASHBOARD.CONSENT}
          className="bg-foreground text-background mt-4 inline-block rounded-md px-4 py-2 text-sm font-medium"
        >
          View consents
        </Link>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: 'ok' | 'warn' | 'bad';
}) {
  const valueTone =
    tone === 'bad'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : '';
  return (
    <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
      <div className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg font-semibold ${valueTone}`}>
        {value}
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>
    </div>
  );
}
