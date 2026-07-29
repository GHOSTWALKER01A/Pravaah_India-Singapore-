'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  ClaimStatusBadge,
  DocStatusBadge,
  PolicyStatusBadge,
  RiskFlagList,
  RiskScoreBadge,
  RiskTierBadge,
} from '@/components/insurance/badges';
import {
  formatAgeLong,
  hoursSince,
  useNow,
} from '@/components/insurance/use-now';
import { Facts } from '@/components/payments/facts';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { insuranceAdminService } from '@/lib/api/insurance/insurance.service';
import type {
  AdminClaimDocument,
  ClaimDecision,
  RevealedDocument,
} from '@/lib/api/insurance/insurance.schema';

/**
 * One claim, and the decision.
 *
 * The page is ordered by what an adjudicator asks in sequence: what is being claimed, was it
 * covered, what does the evidence say, what did the fraud hook find, and what do I decide.
 *
 * ## Three things this screen does that a generic review UI would not
 *
 * **The coverage facts come before the evidence.** A claim outside the waiting period or above
 * the remaining cover is refused on the contract, not on judgement — and a reviewer who reads
 * the bill first will have formed a view before discovering the claim was never payable.
 *
 * **The underwriting provenance is on the page.** A reviewer weighing a suspicious claim needs
 * to know whether this holder was priced as a good risk and is now claiming, or was always
 * substandard. Either answer is legitimate; not being able to see it is not.
 *
 * **The reason is required on an APPROVAL too.** An approval nobody has to justify is the shape
 * of internal fraud. The server enforces it; the form does not pretend otherwise by leaving the
 * field optional and failing on submit.
 */
export default function ClaimDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const client = useQueryClient();

  const [decision, setDecision] = useState<ClaimDecision>('APPROVE');
  const [reason, setReason] = useState('');
  const [approveMajor, setApproveMajor] = useState('');
  const [revealed, setRevealed] = useState<Record<string, RevealedDocument>>({});

  // A ticking clock, so the waiting time stays true on a tab left open — and stays a pure
  // value during render. See `use-now.ts`.
  const now = useNow();

  const claim = useQuery({
    queryKey: ['insurance-claim', id],
    queryFn: () => insuranceAdminService.claimDetail(id),
  });

  const decide = useMutation({
    mutationFn: () =>
      insuranceAdminService.decide(id, {
        decision,
        reason: reason.trim(),
        // Only meaningful on an APPROVE, and the server refuses it on the other branches
        // rather than silently ignoring a contradicted intent about somebody's money.
        ...(decision === 'APPROVE' && approveMajor
          ? { approveMinor: toMinor(approveMajor) }
          : {}),
      }),
    onSuccess: () => {
      setReason('');
      setApproveMajor('');
      void client.invalidateQueries({ queryKey: ['insurance-claim', id] });
      void client.invalidateQueries({ queryKey: ['insurance-claims'] });
      void client.invalidateQueries({ queryKey: ['insurance-stats'] });
      void client.invalidateQueries({ queryKey: ['insurance-book'] });
    },
  });

  const reveal = useMutation({
    mutationFn: (docId: string) => insuranceAdminService.revealDocument(docId),
    onSuccess: (doc) => setRevealed((prev) => ({ ...prev, [doc.id]: doc })),
  });

  if (claim.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading the claim…</p>;
  }
  if (!claim.data) {
    return <p className="text-sm">This claim could not be found.</p>;
  }

  const c = claim.data;
  const decidable = c.status === 'UNDER_REVIEW' || c.status === 'INFO_REQUESTED';
  const reasonTooShort = reason.trim().length < 5;

  /**
   * How long this claim has been waiting.
   *
   * The server sends `submittedAt` rather than a duration, which is the right call — a
   * pre-computed age would be stale by the time it rendered.
   */
  const ageHours = hoursSince(c.submittedAt, now);

  return (
    <div className="space-y-8">
      {/* ── 1. what is being claimed ──────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-xl font-semibold">{c.claimNumber}</h1>
            <ClaimStatusBadge status={c.status} />
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {c.type.replace(/_/g, ' ').toLowerCase()} · filed{' '}
            {formatDateTime(c.submittedAt)} · waiting {formatAgeLong(ageHours)}
          </p>
        </div>
        <Link
          href={ROUTES.DASHBOARD.INSURANCE_CLAIMS}
          className="text-sm underline"
        >
          ← Back to the queue
        </Link>
      </header>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-md border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Claimed
          </div>
          <div className="mt-1 font-mono text-2xl">
            {c.amountClaimed.formatted}
          </div>
          {c.amountApproved ? (
            <div className="text-muted-foreground mt-1 text-xs">
              approved {c.amountApproved.formatted}
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Cover remaining
          </div>
          <div className="mt-1 font-mono text-2xl">
            {c.policy.remainingCover.formatted}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            of {c.policy.coverage.formatted} sum insured
          </div>
        </div>

        <div className="rounded-md border border-black/10 p-4 dark:border-white/10">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Fraud score
          </div>
          <div className="mt-2">
            <RiskScoreBadge score={c.risk.score} />
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            auto-approval is blocked at 0.30
          </div>
        </div>
      </section>

      {/* ── 2. was it covered ────────────────────────────────────────────────── */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Facts
          title="The contract"
          rows={[
            ['Policy', c.policy.policyNumber],
            ['Policy status', c.policy.status],
            ['Incident date', formatDateTime(c.incidentDate)],
            ['Filed', formatDateTime(c.submittedAt)],
            [
              'Waiting period',
              c.underwriting
                ? `${c.underwriting.waitingPeriodDays} days`
                : 'unknown',
            ],
          ]}
        />

        {/*
          The underwriting provenance.

          On this page because it answers the reviewer's question about a suspicious claim, and
          because a premium derived from somebody's financial behaviour should be traceable to
          the model version that produced it. The pricing version plus the quote is what a
          dispute about "why was I charged this" is argued from.
        */}
        {c.underwriting ? (
          <div className="rounded-md border border-black/10 dark:border-white/10">
            <div className="border-b border-black/10 px-4 py-2 text-sm font-semibold dark:border-white/10">
              How this holder was priced
            </div>
            <dl className="divide-y divide-black/5 dark:divide-white/5">
              <div className="flex items-baseline justify-between gap-4 px-4 py-2">
                <dt className="text-muted-foreground text-xs">Risk tier</dt>
                <dd>
                  <RiskTierBadge tier={c.underwriting.riskTier} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 px-4 py-2">
                <dt className="text-muted-foreground text-xs">M2 band</dt>
                <dd className="font-mono text-xs">
                  {c.underwriting.scoreBand ?? 'thin file — no score'}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 px-4 py-2">
                <dt className="text-muted-foreground text-xs">Score confidence</dt>
                <dd className="font-mono text-xs">
                  {c.underwriting.confidence === null
                    ? '—'
                    : `${(c.underwriting.confidence * 100).toFixed(0)}%`}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 px-4 py-2">
                <dt className="text-muted-foreground text-xs">Pricing model</dt>
                <dd className="font-mono text-xs">
                  {c.underwriting.pricingModelVersion}
                </dd>
              </div>
            </dl>
            <p className="text-muted-foreground border-t border-black/10 px-4 py-2 text-xs dark:border-white/10">
              Age, gender and nationality are never pricing inputs — M2 keeps them out of the
              feature vector entirely, so there is no protected attribute for underwriting to
              have read.
            </p>
          </div>
        ) : null}
      </section>

      {/* ── 3. what the claimant said ────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">In the claimant&apos;s words</h2>
        <blockquote className="rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
          {c.description}
        </blockquote>
      </section>

      {/* ── 4. the evidence ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Evidence</h2>

        {c.documents.length === 0 ? (
          <p className="rounded-md border border-amber-500/60 bg-amber-50/50 p-4 text-sm dark:bg-amber-950/20">
            No documents were attached. Consider REQUEST_INFO with the specific document you
            need rather than rejecting — a claim short of evidence is usually one the claimant
            can fix in ten minutes.
          </p>
        ) : (
          <div className="space-y-3">
            {c.documents.map((doc) => (
              <DocumentPanel
                key={doc.id}
                doc={doc}
                claimedMinor={c.amountClaimed.minor}
                revealed={revealed[doc.id]}
                revealing={reveal.isPending && reveal.variables === doc.id}
                onReveal={() => reveal.mutate(doc.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 5. what the fraud hook found ────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Fraud signals</h2>
        <div className="rounded-md border border-black/10 p-4 dark:border-white/10">
          <RiskFlagList flags={c.risk.flags} />
          {c.claimHistory.otherClaimsByHolder > 0 ? (
            <p className="text-muted-foreground mt-3 border-t border-black/10 pt-3 text-xs dark:border-white/10">
              This holder has {c.claimHistory.otherClaimsByHolder} other claim
              {c.claimHistory.otherClaimsByHolder === 1 ? '' : 's'} on record. That is
              context, not a disqualification — a person who claims twice in a bad year is
              exactly who this cover is for, and people are wrongly rejected.
            </p>
          ) : null}
        </div>
      </section>

      {/* ── 6. the decision ────────────────────────────────────────────────── */}
      {decidable ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Decide</h2>
          <div className="space-y-4 rounded-md border border-black/10 p-4 dark:border-white/10">
            <div className="flex flex-wrap gap-2">
              {(['APPROVE', 'REQUEST_INFO', 'REJECT'] as ClaimDecision[]).map(
                (option) => (
                  <button
                    key={option}
                    onClick={() => setDecision(option)}
                    aria-pressed={decision === option}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      decision === option
                        ? 'border-transparent bg-black/85 text-white dark:bg-white/90 dark:text-black'
                        : 'border-black/15 text-zinc-600 hover:bg-black/5 dark:border-white/15 dark:text-zinc-400 dark:hover:bg-white/5'
                    }`}
                  >
                    {option === 'APPROVE'
                      ? 'Approve'
                      : option === 'REJECT'
                        ? 'Reject'
                        : 'Ask for more'}
                  </button>
                ),
              )}
            </div>

            {decision === 'APPROVE' ? (
              <label className="block">
                <span className="text-muted-foreground text-xs">
                  Approve less than claimed (optional, whole{' '}
                  {c.amountClaimed.currency === 'INR' ? 'rupees' : 'dollars'})
                </span>
                <input
                  value={approveMajor}
                  onChange={(event) =>
                    setApproveMajor(event.target.value.replace(/[^0-9]/g, ''))
                  }
                  placeholder={`full ${c.amountClaimed.formatted}`}
                  className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
                />
                <span className="text-muted-foreground mt-1 block text-xs">
                  Capped server-side at both the claimed amount and the remaining cover, so a
                  fat-fingered extra zero cannot pay out more than the contract allows.
                </span>
              </label>
            ) : null}

            <label className="block">
              <span className="text-muted-foreground text-xs">
                Reason (required, and it is shown to the claimant)
              </span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                placeholder={
                  decision === 'APPROVE'
                    ? 'Payslip and hospital record both consistent with eleven days of lost work.'
                    : decision === 'REJECT'
                      ? 'The uploaded bill was assessed as altered; the amount does not match the hospital record.'
                      : 'Please upload the discharge summary — the bill alone does not show the dates of admission.'
                }
                className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
              />
              <span className="text-muted-foreground mt-1 block text-xs">
                {/*
                  Why the reason is mandatory on every branch, stated where it is being typed.

                  An approval nobody has to justify is the shape of internal fraud. A rejection
                  with no stated ground is one the claimant cannot appeal.
                */}
                Required on an approval too. This is the sentence a claimant reads, and the one
                an appeal turns on.
              </span>
            </label>

            {decide.isError ? (
              <p className="text-sm text-red-600 dark:text-red-400">
                {decide.error instanceof Error
                  ? decide.error.message
                  : 'That decision could not be recorded.'}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button
                onClick={() => decide.mutate()}
                disabled={reasonTooShort || decide.isPending}
              >
                {decide.isPending
                  ? 'Recording…'
                  : decision === 'APPROVE'
                    ? 'Approve and pay out'
                    : decision === 'REJECT'
                      ? 'Reject this claim'
                      : 'Ask the claimant for more'}
              </Button>
              {decision === 'APPROVE' ? (
                <span className="text-muted-foreground text-xs">
                  The payout posts to the holder&apos;s wallet over the M4 ledger, idempotent on
                  the claim id.
                </span>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        /* ── the decision already made ─────────────────────────────────────── */
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">The decision</h2>
          <Facts
            title={`${c.status} — no further action available`}
            rows={[
              ['Decision', c.decision.decision ?? '—'],
              ['Reason', c.decision.reason ?? '—'],
              [
                'Decided by',
                c.decision.byType === 'SYSTEM'
                  ? 'SYSTEM (auto-approved: small, low-risk, verified)'
                  : (c.decision.reviewer?.email ?? c.decision.byType ?? '—'),
              ],
              ['Decided at', c.decision.decidedAt ? formatDateTime(c.decision.decidedAt) : '—'],
              ['Paid at', c.payout.paidAt ? formatDateTime(c.payout.paidAt) : '—'],
              ['Payout transaction', c.payout.transactionId ?? 'not yet settled'],
              ['Insurer reference', c.external.insurerClaimRef ?? '—'],
            ]}
          />

          {/*
            The one state that needs an operator's eye on this page.

            APPROVED with no payout transaction means the claimant has been told they will be
            paid and has not been. There is deliberately no APPROVED → REJECTED edge, so the
            only correct action is to make the payout land — the lifecycle sweep on the book
            page retries it.
          */}
          {c.payout.pending ? (
            <p className="rounded-md border border-red-500/60 bg-red-50/50 p-4 text-sm dark:bg-red-950/20">
              This claim is approved and the payout has not settled. The claimant has been told
              they will be paid. The decision cannot be reversed — run the lifecycle sweep on
              the book page to retry the payout, and escalate if it does not clear.
            </p>
          ) : null}

          {c.payout.transactionId ? (
            <Link
              href={ROUTES.DASHBOARD.PAYMENT_DETAIL(c.payout.transactionId)}
              className="inline-block text-sm underline"
            >
              Open the payout on the ledger →
            </Link>
          ) : null}
        </section>
      )}

      <footer className="text-muted-foreground border-t border-black/10 pt-4 text-xs dark:border-white/10">
        <PolicyStatusBadge status={c.policy.status} className="mr-2" />
        Holder {c.holder.pravaahId ?? 'unknown'} · {c.holder.country}. The holder is identified
        by their public Pravaah ID only; this console never shows a document number.
      </footer>
    </div>
  );
}

/**
 * One document, with its extraction behind an explicit reveal.
 *
 * ## Why the OCR extraction is not shown by default
 *
 * A hospital bill names a diagnosis and a treating physician — health data about an identified
 * person. So it is field-encrypted at rest, and decrypting it is an ACTION that writes its own
 * audit row naming the admin who did it. Rendering it automatically on page load would attribute
 * a read to anybody who merely opened the claim, which destroys the value of the audit trail:
 * if everyone has read everything, the log answers nothing.
 *
 * The tamper score IS shown up front, and to an admin only. They are the human the flag exists to
 * summon, and they need it before deciding whether to look at the contents at all.
 */
function DocumentPanel({
  doc,
  claimedMinor,
  revealed,
  revealing,
  onReveal,
}: {
  doc: AdminClaimDocument;
  /** The claimed amount in minor units, for the reviewer's eyeball comparison. */
  claimedMinor: string;
  revealed: RevealedDocument | undefined;
  revealing: boolean;
  onReveal: () => void;
}) {
  const suspect = doc.status === 'SUSPECT';

  /**
   * Whether the document's own amount is below what was claimed.
   *
   * A digit-length-then-lexicographic compare, not `Number()`. Both operands are minor-unit
   * strings and `lib/api/payments/money.ts` forbids converting those — a longer digit string is
   * always the larger number once leading zeros are stripped, so the comparison needs no
   * arithmetic at all.
   */
  const understatesClaim = (() => {
    const extracted = doc.extractedAmount?.minor;
    if (!extracted) return false;
    const a = extracted.replace(/^0+(?=[0-9])/, '');
    const b = claimedMinor.replace(/^0+(?=[0-9])/, '');
    if (a.length !== b.length) return a.length < b.length;
    return a < b;
  })();

  return (
    <div
      className={`rounded-md border p-4 ${
        suspect
          ? 'border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20'
          : 'border-black/10 dark:border-white/10'
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="text-sm font-medium">
            {doc.docType.replace(/_/g, ' ').toLowerCase()}
          </span>
          <span className="ml-2">
            <DocStatusBadge status={doc.status} />
          </span>
        </div>
        <span className="text-muted-foreground font-mono text-xs">
          {formatDateTime(doc.uploadedAt)}
        </span>
      </div>

      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Alteration score</dt>
          <dd
            className={`font-mono ${
              suspect ? 'text-amber-700 dark:text-amber-400' : ''
            }`}
          >
            {doc.tamperScore === null ? '—' : doc.tamperScore.toFixed(2)}
            {suspect ? ' · over the 0.80 gate' : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Read confidence</dt>
          <dd className="font-mono">
            {doc.ocrConfidence === null ? '—' : doc.ocrConfidence.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Amount on the document</dt>
          {/*
            Whether it understates the claim is derived here, not sent.

            The server puts the mismatch in the FRAUD SIGNALS (`AMOUNT_MISMATCH`) with the
            tolerance applied, which is where the decision-grade version belongs. This column
            is the reviewer's own eyeball check against the claimed figure, so a bare
            comparison is the honest thing to show — and it deliberately does not restate the
            5% tolerance, because a reviewer reading two numbers does not need our threshold to
            see that ₹1,245 is not ₹12,450.
          */}
          <dd
            className={`font-mono ${
              understatesClaim ? 'text-amber-700 dark:text-amber-400' : ''
            }`}
          >
            {doc.extractedAmount?.formatted ?? 'not found'}
            {understatesClaim ? ' · below the claim' : ''}
          </dd>
        </div>
      </dl>

      {suspect ? (
        <p className="mt-3 text-xs">
          This tripped the alteration check, so the claim could not auto-approve. The score is a
          heuristic — a photocopy, a re-saved scan or a bad thermal printer all score high — so
          it is a reason to look, not a finding of fraud. The claimant has NOT been told their
          document looks altered.
        </p>
      ) : null}

      <div className="mt-3">
        {revealed ? (
          <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
            <div className="text-muted-foreground text-xs">
              Extracted fields · this read is logged against your account
            </div>
            <ExtractedFields fields={revealed.fields} />
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onReveal}
            disabled={revealing}
          >
            {revealing ? 'Decrypting…' : 'Reveal extracted contents'}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The decrypted extraction, narrowed at the boundary.
 *
 * `fields` is `unknown` on the wire because the column is `Json` and the server sends whatever
 * the OCR provider put there — a real vendor's field set is not something our type system gets to
 * assert. So it is narrowed HERE, once, and anything that is not a flat string map renders as
 * pretty-printed JSON rather than being dropped.
 *
 * Dropping it would be the tempting alternative and the wrong one: a reviewer who has just spent
 * an audited read on a document must see whatever came back, even if it is a shape this console
 * did not anticipate.
 */
function ExtractedFields({ fields }: { fields: unknown }) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return (
      <p className="mt-1 text-xs">
        {fields === null || fields === undefined
          ? 'No fields were extracted.'
          : JSON.stringify(fields)}
      </p>
    );
  }

  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) {
    return <p className="mt-1 text-xs">No fields were extracted.</p>;
  }

  return (
    <dl className="mt-1 space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex justify-between gap-4 text-xs">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="font-mono break-all">
            {typeof value === 'string' || typeof value === 'number'
              ? String(value)
              : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Whole major units → integer minor units.
 *
 * STRING SURGERY, not arithmetic. `Number(major) * 100` is the obvious version and it is wrong
 * for the reason `lib/api/payments/money.ts` documents: `4.35 * 100` is `434.99999999999994`, and
 * the field where an operator sets what a claimant is actually paid is the last place a rounding
 * artefact belongs. Multiplying a whole number by 100 is appending two zeros, so no arithmetic is
 * needed at all — and there is no `BigInt` either, because this app targets ES2017.
 *
 * Leading zeros are stripped so `007` does not become `00700`, which the server's digit-string
 * schema would reject as malformed.
 */
function toMinor(major: string): string {
  const digits = major.replace(/[^0-9]/g, '').replace(/^0+(?=[0-9])/, '');
  if (digits.length === 0 || digits === '0') return '0';
  return `${digits}00`;
}
