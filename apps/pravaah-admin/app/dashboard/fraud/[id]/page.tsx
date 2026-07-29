'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  CaseStatusBadge,
  DecisionBadge,
  ScoreReadout,
  SeverityBadge,
  SignalBar,
  subjectLabel,
} from '@/components/fraud/badges';
import {
  formatAgeLong,
  hoursSince,
  useNow,
} from '@/components/insurance/use-now';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';
import type { FraudCaseOutcome } from '@/lib/api/fraud/fraud.schema';

/**
 * One fraud case, and the decision.
 *
 * ## Why the signal trail is the largest thing on this page
 *
 * The decision an analyst is about to make releases or refuses somebody's money, and the only
 * defensible basis for it is what actually fired. So the signals come with their WEIGHT and
 * their DEGREE and their contribution, because those three answer different questions: what
 * the policy says this signal is worth, how strongly it fired here, and what it therefore
 * contributed to the number.
 *
 * A console that showed only the score would make every case look equally decided, and an
 * analyst would end up rubber-stamping — which is the failure mode that turns a
 * human-in-the-loop control into a formality.
 *
 * ## Why a note is mandatory on every outcome, including CLEARED
 *
 * A release nobody had to justify is precisely the shape of insider fraud. It is also the record
 * the customer is owed if they later ask why their money was held. The server enforces a
 * minimum length; this screen refuses to submit without one so the analyst finds out before
 * losing what they typed.
 *
 * ## Why `actionApplied` is reported separately from the outcome
 *
 * They can genuinely disagree. A case can be CLEARED while the release fails because the
 * transaction expired during review — and an analyst told only "resolved" would believe a
 * payment went out that never did. That is the quietest failure in this module, so it gets its
 * own line and its own colour.
 */
export default function FraudCaseDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;
  const queryClient = useQueryClient();
  const now = useNow();

  const [note, setNote] = useState('');
  const [pendingOutcome, setPendingOutcome] = useState<FraudCaseOutcome | null>(
    null,
  );

  const detail = useQuery({
    queryKey: ['fraud-case', caseId],
    queryFn: () => fraudAdminService.caseDetail(caseId),
  });

  /**
   * Every mutation invalidates the queue and the stats as well as this case.
   *
   * The sidebar badge reads `['fraud-stats']`, so resolving a case updates the SLA counter with
   * no extra plumbing — the same shared-key discipline `use-nav-signals` documents.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['fraud-case', caseId] });
    void queryClient.invalidateQueries({ queryKey: ['fraud-cases'] });
    void queryClient.invalidateQueries({ queryKey: ['fraud-stats'] });
  };

  const claim = useMutation({
    mutationFn: () => fraudAdminService.claimCase(caseId),
    onSuccess: () => {
      toast.success('This case is yours');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const addNote = useMutation({
    mutationFn: (text: string) => fraudAdminService.addNote(caseId, text),
    onSuccess: () => {
      toast.success('Note added');
      setNote('');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const requestInfo = useMutation({
    mutationFn: (text: string) => fraudAdminService.requestInfo(caseId, text),
    onSuccess: () => {
      toast.success('Information requested — the SLA clock is paused');
      setNote('');
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const resolve = useMutation({
    mutationFn: (outcome: FraudCaseOutcome) =>
      fraudAdminService.resolveCase(caseId, { outcome, note }),
    onSuccess: (result) => {
      /**
       * The toast distinguishes "decided AND applied" from "decided only".
       *
       * A success toast on a case whose release failed would be the console lying at the exact
       * moment it matters most. The detail is surfaced verbatim from the server.
       */
      if (result.actionApplied) {
        toast.success('Case resolved and the action applied');
      } else {
        toast.warning(`Case resolved. ${result.actionResult}`);
      }
      setNote('');
      setPendingOutcome(null);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (detail.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading this case…</p>;
  }

  const row = detail.data;
  if (!row) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Could not load this case.
      </p>
    );
  }

  const resolved = row.resolvedAt !== null;
  const noteTooShort = note.trim().length < 5;
  const busy =
    resolve.isPending || addNote.isPending || requestInfo.isPending;

  return (
    <div className="space-y-6">
      {/* ── HEADER ────────────────────────────────────────────────────────── */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {subjectLabel(row.subjectType)} case
          </h1>
          <SeverityBadge severity={row.severity} />
          <CaseStatusBadge status={row.status} />
        </div>

        <p className="text-muted-foreground text-sm">
          Opened {formatAgeLong(hoursSince(row.openedAt, now))} ago ·{' '}
          {formatDateTime(row.openedAt)}
          {row.slaDueAt && !resolved ? (
            <>
              {' · '}
              <span
                className={
                  row.slaBreached
                    ? 'font-medium text-red-600 dark:text-red-400'
                    : ''
                }
              >
                {row.slaBreached
                  ? 'past SLA'
                  : `SLA due ${formatDateTime(row.slaDueAt)}`}
              </span>
            </>
          ) : null}
        </p>

        {/*
          The applied/not-applied line. See the note in the header comment on why it is
          separate from the status.
        */}
        {resolved ? (
          <p
            className={`text-sm ${
              row.actionApplied
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {row.actionApplied
              ? 'The downstream action was applied.'
              : `Downstream action NOT applied — ${row.actionResult ?? 'no detail recorded'}`}
          </p>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* ── LEFT: the evidence ──────────────────────────────────────────── */}
        <div className="space-y-6">
          {/* THE SIGNAL TRAIL */}
          <section className="rounded-lg border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">What fired</h2>
              {row.assessment ? (
                <div className="flex items-center gap-3">
                  <ScoreReadout score={row.assessment.score} />
                  <DecisionBadge decision={row.assessment.decision} />
                </div>
              ) : null}
            </div>

            {row.assessment ? (
              <>
                <ul className="space-y-2">
                  {/*
                    Sorted by CONTRIBUTION, hard signals first.

                    An unsorted list buries the deciding signal among contextual ones — and on
                    this page the deciding signal is the entire justification the analyst is
                    about to rely on.
                  */}
                  {[...row.assessment.signals]
                    .sort((a, b) => {
                      if (a.isHard !== b.isHard) return a.isHard ? -1 : 1;
                      return b.weight * b.value - a.weight * a.value;
                    })
                    .map((signal) => (
                      <li
                        key={signal.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-xs">
                            {signal.type}
                            {signal.isHard ? (
                              <span className="ml-2 text-red-600 dark:text-red-400">
                                bypassed scoring
                              </span>
                            ) : null}
                          </p>
                          {/* The customer-facing wording, so the analyst sees what THEY saw. */}
                          <p className="text-muted-foreground text-xs">
                            {signal.reason}
                          </p>
                        </div>
                        <SignalBar
                          weight={signal.weight}
                          value={signal.value}
                          isHard={signal.isHard}
                        />
                      </li>
                    ))}
                </ul>

                {/*
                  The model version, on every case.

                  The weights ARE the policy, so a score from before a re-tune cannot be
                  compared with one from after — and an appeal months from now has to be argued
                  against the rules that actually applied at the time.
                */}
                <p className="text-muted-foreground mt-3 font-mono text-[11px]">
                  {row.assessment.modelVersion}
                  {row.assessment.geoHint ? ` · ${row.assessment.geoHint}` : ''}
                  {' · '}
                  {formatDateTime(row.assessment.computedAt)}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                No assessment is attached to this case. It was opened without one, which
                should not happen — check the audit trail.
              </p>
            )}
          </section>

          {/* THE NOTE TRAIL */}
          <section className="rounded-lg border p-4">
            <h2 className="mb-3 font-medium">
              Investigation trail
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                append-only
              </span>
            </h2>

            {row.notes.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing recorded yet.
              </p>
            ) : (
              <ol className="space-y-3">
                {row.notes.map((entry) => (
                  <li key={entry.id} className="border-l-2 pl-3">
                    <p className="text-sm">{entry.note}</p>
                    <p className="text-muted-foreground mt-1 text-[11px]">
                      {formatDateTime(entry.createdAt)}
                      {entry.action ? ` · ${entry.action}` : ''}
                      {' · '}
                      <span className="font-mono">
                        {entry.analystId.slice(0, 8)}
                      </span>
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* ── RIGHT: the customer, and the decision ───────────────────────── */}
        <div className="space-y-6">
          <section className="rounded-lg border p-4">
            <h2 className="mb-3 font-medium">Customer</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Pravaah ID">
                <Link
                  href={ROUTES.DASHBOARD.FRAUD_USER(row.userId)}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {row.user.pravaahId ?? row.userId}
                </Link>
              </Row>
              <Row label="KYC">{row.user.kycStatus}</Row>
              <Row label="Joined">{formatDateTime(row.user.createdAt)}</Row>
              {row.user.isSuspended ? (
                <Row label="Account">
                  <span className="text-red-600 dark:text-red-400">
                    Suspended
                  </span>
                </Row>
              ) : null}
            </dl>

            {/*
              The full risk picture is one click away, not inlined.

              Devices, the mule cluster, past decisions and other cases are a page's worth of
              material, and an analyst needs them for maybe one case in five. Inlining them
              would push the DECISION — the reason this page exists — below the fold.
            */}
            <Link
              href={ROUTES.DASHBOARD.FRAUD_USER(row.userId)}
              className="mt-3 inline-block text-sm underline underline-offset-2"
            >
              Open the full risk picture →
            </Link>
          </section>

          {/* THE DECISION */}
          {resolved ? (
            <section className="rounded-lg border p-4">
              <h2 className="mb-2 font-medium">Resolved</h2>
              <p className="text-muted-foreground text-sm">
                {row.resolution ?? 'No resolution note recorded.'}
              </p>
              <p className="text-muted-foreground mt-2 text-[11px]">
                {/*
                  Terminal, and the copy says so.

                  CLEARED and CONFIRMED_FRAUD cannot be revisited server-side — a case whose
                  outcome could be re-decided after the money moved is a case an insider can
                  rewrite. Saying it here stops an analyst hunting for a button that does not
                  exist.
                */}
                This outcome is final. A new concern about this account needs a new case.
              </p>
            </section>
          ) : (
            <section className="space-y-3 rounded-lg border p-4">
              <h2 className="font-medium">Decide</h2>

              {row.assignedAnalystId === null ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    Claim this case before working it, so two analysts do not decide it at
                    once.
                  </p>
                  <Button
                    onClick={() => claim.mutate()}
                    disabled={claim.isPending}
                    className="w-full"
                  >
                    {claim.isPending ? 'Claiming…' : 'Claim this case'}
                  </Button>
                </>
              ) : null}

              <div className="space-y-1">
                <label
                  htmlFor="case-note"
                  className="block text-xs font-medium"
                >
                  Reason
                  <span className="text-muted-foreground ml-1 font-normal">
                    required on every outcome
                  </span>
                </label>
                <textarea
                  id="case-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={4}
                  placeholder="What you checked, who you spoke to, and what you concluded."
                  className="w-full rounded-md border bg-transparent p-2 text-sm"
                />
                {/*
                  The length rule is stated BEFORE submission, not discovered from a 400.

                  An analyst who loses four sentences to a validation error learns to write
                  one word next time, which is exactly the outcome the requirement exists to
                  prevent.
                */}
                {note.length > 0 && noteTooShort ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    A few more words — this is the record the customer is owed.
                  </p>
                ) : null}
              </div>

              {/*
                Two-step confirmation on the two outcomes that MOVE something.

                Clearing releases money; confirming suspends an account and lists a payee that
                every future customer will then be blocked from paying. Neither should be one
                click from a keyboard-focused button. Escalating and note-adding are reversible
                and are single-click.
              */}
              {pendingOutcome ? (
                <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
                  <p className="text-sm font-medium">
                    {pendingOutcome === 'CLEARED'
                      ? 'Release this action?'
                      : 'Confirm fraud on this account?'}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {pendingOutcome === 'CLEARED'
                      ? 'The held action proceeds, and the customer stops being re-flagged for the same behaviour.'
                      : 'The account is suspended, the counterparty is added to the mule list, and cross-border cases are flagged for STR filing.'}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => resolve.mutate(pendingOutcome)}
                      disabled={busy}
                      variant={
                        pendingOutcome === 'CLEARED' ? 'default' : 'destructive'
                      }
                    >
                      {resolve.isPending ? 'Applying…' : 'Yes, do it'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setPendingOutcome(null)}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    disabled={noteTooShort || busy}
                    onClick={() => setPendingOutcome('CLEARED')}
                  >
                    Clear — false positive
                  </Button>
                  <Button
                    className="w-full"
                    variant="destructive"
                    disabled={noteTooShort || busy}
                    onClick={() => setPendingOutcome('CONFIRMED_FRAUD')}
                  >
                    Confirm fraud
                  </Button>
                  <Button
                    className="w-full"
                    variant="outline"
                    disabled={noteTooShort || busy}
                    onClick={() => resolve.mutate('ESCALATED')}
                  >
                    Escalate to compliance
                  </Button>
                  <Button
                    className="w-full"
                    variant="ghost"
                    disabled={noteTooShort || busy}
                    onClick={() => requestInfo.mutate(note)}
                  >
                    Ask the customer — pauses the SLA
                  </Button>
                  <Button
                    className="w-full"
                    variant="ghost"
                    disabled={noteTooShort || busy}
                    onClick={() => addNote.mutate(note)}
                  >
                    Just add a note
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
