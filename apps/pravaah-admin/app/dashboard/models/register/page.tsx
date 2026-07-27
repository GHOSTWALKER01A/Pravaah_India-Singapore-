'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ROUTES } from '@/features/routes';
import { scoringService } from '@/lib/api/scoring/scoring.service';

/**
 * Register a model version.
 *
 * A paste-the-payload form rather than a field-by-field builder, deliberately:
 * `python -m app.train` already PRINTS the exact JSON, and retyping a feature
 * schema by hand is how an artefact and its registry entry drift apart. The form's
 * job is to validate the paste, explain a rejection, and make the immutability rule
 * impossible to miss.
 */
export default function RegisterModelPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [json, setJson] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const parsed = (() => {
    if (!json.trim()) return null;
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  const register = useMutation({
    mutationFn: async () => {
      if (!parsed) throw new Error('The payload is not valid JSON.');
      return scoringService.registerModel(parsed);
    },
    onSuccess: (model) => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      toast.success(`Registered v${model.version}`, {
        description:
          'It is INACTIVE and UNAUDITED. Run the fairness audit — activation is blocked until it passes.',
      });
      router.push(ROUTES.DASHBOARD.MODEL_DETAIL(model.id));
    },
    // The backend's Zod issues and the 409 immutability message are the useful
    // explanation. Shown as-is rather than flattened into "something went wrong".
    onError: (err) =>
      toast.error('Registration rejected', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  });

  const summary = parsed
    ? {
        name: typeof parsed.name === 'string' ? parsed.name : '—',
        version: typeof parsed.version === 'string' ? parsed.version : '—',
        runtime: typeof parsed.runtime === 'string' ? parsed.runtime : 'scorecard',
        features: Array.isArray(
          (parsed.featureSchema as { features?: unknown[] })?.features,
        )
          ? (parsed.featureSchema as { features: unknown[] }).features.length
          : 0,
        bands: Array.isArray(parsed.bands) ? parsed.bands.length : 0,
        hasScorecard: Boolean(parsed.scorecard),
      }
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={ROUTES.DASHBOARD.MODELS}
          className="text-muted-foreground text-xs hover:underline"
        >
          ← Models
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Register a model version</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Paste the payload <code>python -m app.train</code> printed. Pasting rather
          than retyping is the point — a hand-typed feature schema is how an
          artefact and its registry entry drift apart.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          Two rules worth knowing before you submit
        </div>
        <ul className="text-muted-foreground mt-2 space-y-1.5 text-sm">
          <li>
            <strong>Versions are immutable.</strong> Re-registering an existing
            version is refused. Scores are stamped with their version, so editing
            one would silently rewrite the meaning of every score already issued
            under it. Publish a new version instead.
          </li>
          <li>
            <strong>Registering does not make it servable.</strong> It arrives
            inactive and unaudited; the fairness gate blocks activation until an
            audit passes.
          </li>
          <li>
            A <code>fastapi</code> runtime needs <code>ML_BASE_URL</code> set and
            the ML service serving <em>this exact version</em> — it returns 409 on a
            mismatch rather than answer as a model it is not.
          </li>
        </ul>
      </div>

      <div className="space-y-2">
        <label htmlFor="payload" className="text-sm font-medium">
          Registration payload (JSON)
        </label>
        <textarea
          id="payload"
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            setParseError(null);
          }}
          onBlur={() => {
            if (json.trim() && !parsed) setParseError('Not valid JSON.');
          }}
          rows={18}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          className="border-input w-full rounded-md border bg-transparent p-3 font-mono text-xs"
        />
        {parseError && (
          <p className="text-destructive text-sm">{parseError}</p>
        )}
      </div>

      {/* A read-back of what was actually parsed, so a truncated paste is obvious
          before it becomes a server-side validation error. */}
      {summary && (
        <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Parsed
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Row label="Name" value={summary.name} />
            <Row label="Version" value={summary.version} />
            <Row label="Runtime" value={summary.runtime} />
            <Row
              label="Features"
              value={summary.features ? String(summary.features) : '⚠ none found'}
            />
            <Row
              label="Bands"
              value={summary.bands ? String(summary.bands) : '⚠ none found'}
            />
            <Row
              label="Scorecard params"
              value={
                summary.hasScorecard
                  ? 'present'
                  : summary.runtime === 'scorecard'
                    ? '⚠ required for this runtime'
                    : 'not needed'
              }
            />
          </dl>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          onClick={() => register.mutate()}
          disabled={!parsed || register.isPending}
        >
          {register.isPending ? 'Registering…' : 'Register version'}
        </Button>
        <Button variant="outline" asChild>
          <Link href={ROUTES.DASHBOARD.MODELS}>Cancel</Link>
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-32 shrink-0">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

const PLACEHOLDER = `{
  "name": "pravaah-credit",
  "version": "1.2.0",
  "runtime": "fastapi",
  "featureSchema": { "features": [ { "name": "monthly_inflow", "dtype": "float", "optional": false } ] },
  "bands": [ { "min": 300, "max": 579, "band": "POOR" } ],
  "trainedAt": "2026-07-25T00:00:00+05:30",
  "datasetRef": "synthetic-xgboost-50000r-seed20260718",
  "notes": "Gradient-boosted candidate; captures feature interactions."
}`;
