'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Facts } from '@/components/payments/facts';
import { LedgerTable } from '@/components/payments/ledger-table';
import { ROUTES } from '@/features/routes';
import { formatDateTime } from '@/helper/date-convertor';
import { formatMoney } from '@/lib/api/payments/money';
import { paymentsAdminService } from '@/lib/api/payments/payments.service';

/**
 * One payment, in full.
 *
 * The page is ordered by what an operator asks in sequence: what is this, what did the ledger do,
 * what did the rail say, and what can I do about it. The two break-glass controls sit last and are
 * gated behind a typed reason, because each one moves customer money on a human's judgement with no
 * rail event to corroborate it.
 *
 * The ledger is shown PER LEG, never netted. That is the entire value of an append-only ledger
 * during an incident: the reserve, the fee, the currency crossing and the payout as separate,
 * timestamped facts you can read in order. A single "amount" row would answer nothing.
 */
export default function PaymentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const client = useQueryClient();

  const [deemedForm, setDeemedForm] = useState({
    resolution: 'SETTLE' as 'SETTLE' | 'REVERSE',
    evidenceRef: '',
    reason: '',
  });
  const [refundForm, setRefundForm] = useState({ amountMinor: '', reason: '' });
  const [riskForm, setRiskForm] = useState({
    decision: 'RELEASE' as 'RELEASE' | 'BLOCK',
    reason: '',
  });

  const detail = useQuery({
    queryKey: ['admin-transaction', id],
    queryFn: () => paymentsAdminService.transactionDetail(id),
  });

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['admin-transaction', id] });
    void client.invalidateQueries({ queryKey: ['trial-balance'] });
    void client.invalidateQueries({ queryKey: ['payment-stats'] });
  };

  const recheck = useMutation({
    mutationFn: () => paymentsAdminService.recheck(id),
    onSuccess: invalidate,
  });

  const resolveDeemed = useMutation({
    mutationFn: () =>
      paymentsAdminService.resolveDeemed(id, {
        resolution: deemedForm.resolution,
        evidenceRef: deemedForm.evidenceRef,
        reason: deemedForm.reason,
        confirmed: true,
      }),
    onSuccess: invalidate,
  });

  const refund = useMutation({
    mutationFn: () =>
      paymentsAdminService.refund(id, {
        amountMinor: refundForm.amountMinor,
        reason: refundForm.reason,
        confirmed: true,
      }),
    onSuccess: invalidate,
  });

  const resolveRisk = useMutation({
    mutationFn: () =>
      paymentsAdminService.resolveRisk(id, {
        decision: riskForm.decision,
        reason: riskForm.reason,
      }),
    onSuccess: invalidate,
  });

  if (detail.isLoading) {
    return <p className="text-muted-foreground p-6 text-sm">Loading…</p>;
  }
  if (detail.isError || !detail.data) {
    return (
      <p className="p-6 text-sm text-red-600 dark:text-red-400">
        {detail.error instanceof Error ? detail.error.message : 'Could not load this payment.'}
      </p>
    );
  }

  const { transaction: txn, ledger, reversals, reconciliations, railEvents, disputes, beneficiary } =
    detail.data;

  const isDeemed = txn.status === 'DEEMED';
  const isRiskHeld = txn.status === 'RISK_HELD';
  const refundable = txn.status === 'SUCCESS' || txn.status === 'PARTIALLY_REFUNDED';

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href={ROUTES.DASHBOARD.PAYMENTS}
        className="text-muted-foreground text-sm underline underline-offset-4"
      >
        ← All payments
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {formatMoney(txn.totalDebitMinor, txn.sourceCurrency)}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {txn.type} · {txn.corridor === 'CROSS_BORDER' ? 'SG → IN' : 'within India'} ·{' '}
            {txn.provider}
          </p>
          <p className="text-muted-foreground font-mono text-xs">{txn.id}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending}
        >
          {recheck.isPending ? 'Asking the rail…' : 'Ask the rail now'}
        </Button>
      </div>

      {/*
        The DEEMED banner explains what the state means before offering a resolution, because the
        two options are opposites and both irreversible. An operator who does not understand that
        the funds are still in suspense might pick either at random.
      */}
      {isDeemed ? (
        <div className="mt-6 rounded-md border border-amber-500 bg-amber-50 p-4 dark:bg-amber-950/30">
          <h2 className="font-semibold text-amber-800 dark:text-amber-300">
            The rail never gave a final answer
          </h2>
          <p className="mt-1 text-sm text-amber-800/90 dark:text-amber-200/90">
            The funds are held in suspense. Nothing has been paid out and nothing has been
            returned. This is NOT a failure — it means we do not know, and releasing an unknown as
            &ldquo;failed&rdquo; is how a payment gets made twice. Resolve it against a bank
            statement, not a guess.
          </p>
        </div>
      ) : null}

      {isRiskHeld ? (
        <div className="mt-6 rounded-md border border-amber-500 bg-amber-50 p-4 dark:bg-amber-950/30">
          <h2 className="font-semibold text-amber-800 dark:text-amber-300">
            Held by the risk engine
          </h2>
          <p className="mt-1 text-sm text-amber-800/90 dark:text-amber-200/90">
            Nothing has left the wallet. Releasing re-enters the saga at validation, so the
            balance and the day&apos;s limits are re-checked — a hold can sit for hours and the
            money may have been spent since.
          </p>
          {txn.riskFlags.length > 0 ? (
            <ul className="mt-2 list-inside list-disc text-sm text-amber-800/90 dark:text-amber-200/90">
              {txn.riskFlags.map((flag) => (
                <li key={flag} className="font-mono text-xs">
                  {flag}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ── THE PARTICULARS ────────────────────────────────────────────── */}
      <section className="mt-8 grid gap-6 sm:grid-cols-2">
        <Facts
          title="Payment"
          rows={[
            ['Status', txn.status],
            ['Rail code', txn.railCode ?? '—'],
            ['Rail reference', txn.railRef ?? '—'],
            ['UTR', txn.utr ?? '—'],
            ['Purpose', txn.purposeCode],
            ['Status checks spent', String(txn.statusCheckCount)],
            ['Next poll', txn.nextPollAt ? formatDateTime(txn.nextPollAt) : '—'],
            ['Failure reason', txn.failureReason ?? '—'],
          ]}
        />
        <Facts
          title="Amounts"
          rows={[
            ['Source', formatMoney(txn.sourceAmountMinor, txn.sourceCurrency)],
            ['Fee', formatMoney(txn.feeMinor, txn.sourceCurrency)],
            ['Tax', formatMoney(txn.taxMinor, txn.sourceCurrency)],
            ['Total debited', formatMoney(txn.totalDebitMinor, txn.sourceCurrency)],
            ['Destination', formatMoney(txn.destAmountMinor, txn.destCurrency)],
            ['Refunded so far', formatMoney(txn.refundedMinor, txn.sourceCurrency)],
            ['Locked rate (×1e8)', txn.fxRateE8 ?? '—'],
            ['Risk score', txn.riskScore === null ? '—' : txn.riskScore.toFixed(2)],
          ]}
        />
      </section>

      {beneficiary ? (
        <section className="mt-6">
          <Facts
            title="Beneficiary"
            rows={[
              ['Bank-registered name', beneficiary.registeredName ?? '—'],
              ['Saved as', beneficiary.displayName],
              ['Handle (masked)', beneficiary.handle],
              ['Status', beneficiary.status],
              ['Screening hit', beneficiary.screeningHit ? 'YES' : 'no'],
            ]}
          />
        </section>
      ) : null}

      <LedgerTable entries={ledger} />

      {/* ── WHAT THE RAIL SAID ─────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Reconciliation trail</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Append-only, one row per check. &ldquo;Pending at 10:00, pending at 10:02, success at
          10:05 after we had given up&rdquo; is the whole story of a late settlement, and an
          overwritten record would leave only its last frame.
        </p>
        <div className="mt-3 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Checked</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Rail said</TableHead>
                <TableHead>We said</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Action taken</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reconciliations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-6 text-center">
                    Never checked against the rail.
                  </TableCell>
                </TableRow>
              ) : (
                reconciliations.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(record.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs">{record.source}</TableCell>
                    <TableCell className="text-xs">
                      {record.railStatus}
                      {record.railCode ? (
                        <span className="text-muted-foreground font-mono"> {record.railCode}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{record.internalStatus}</TableCell>
                    <TableCell
                      className={`text-xs ${
                        record.status === 'MISMATCH'
                          ? 'text-red-600 dark:text-red-400'
                          : record.status === 'ESCALATED'
                            ? 'text-amber-600 dark:text-amber-400'
                            : ''
                      }`}
                    >
                      {record.status}
                      {record.discrepancy ? (
                        <div className="text-muted-foreground">{record.discrepancy}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{record.action ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {railEvents.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Rail events</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Webhooks received for this payment. The encrypted payload is deliberately not shown here
            — it is evidence for a chargeback months from now, not material for a screen.
          </p>
          <div className="mt-3 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Signature</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Attempts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {railEvents.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatDateTime(event.receivedAt)}
                    </TableCell>
                    <TableCell className="text-xs">{event.provider}</TableCell>
                    <TableCell className="text-xs">{event.kind}</TableCell>
                    <TableCell
                      className={`text-xs ${
                        event.signatureVerified
                          ? 'text-green-600 dark:text-green-400'
                          : 'font-semibold text-red-600 dark:text-red-400'
                      }`}
                    >
                      {event.signatureVerified ? 'verified' : 'NOT VERIFIED'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {event.status}
                      {event.lastError ? (
                        <div className="text-red-600 dark:text-red-400">{event.lastError}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{event.attempts}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      {reversals.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Reversals</h2>
          <div className="mt-3 overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>By admin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reversals.map((reversal) => (
                  <TableRow key={reversal.id}>
                    <TableCell className="text-xs">{reversal.sequence}</TableCell>
                    <TableCell className="text-xs">{reversal.kind}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatMoney(reversal.amountMinor, txn.sourceCurrency)}
                    </TableCell>
                    <TableCell className="text-xs">{reversal.status}</TableCell>
                    <TableCell className="text-xs">{reversal.reason}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {reversal.initiatedByAdminId ?? 'system'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      {disputes.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Disputes</h2>
          <div className="mt-3 space-y-3">
            {disputes.map((dispute) => (
              <div
                key={dispute.id}
                className="rounded-md border border-black/10 p-3 dark:border-white/10"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{dispute.kind}</span>
                  <span className="text-muted-foreground text-xs">{dispute.status}</span>
                </div>
                <p className="mt-1 text-sm">{dispute.description}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  SLA {formatDateTime(dispute.slaDueAt)}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── BREAK-GLASS ────────────────────────────────────────────────── */}
      {isDeemed || isRiskHeld || refundable ? (
        <section className="mt-10 rounded-md border border-red-500/40 p-4">
          <h2 className="text-lg font-semibold">Actions that move money</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Each of these is recorded against your account with the reason you give. They call the
            same services the app and the schedulers use — there is no admin-only path, because two
            implementations of &ldquo;refund&rdquo; would eventually refund differently.
          </p>

          {isDeemed ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                resolveDeemed.mutate();
              }}
            >
              <h3 className="text-sm font-semibold">Resolve the unconfirmed payment</h3>
              <div className="flex gap-4 text-sm">
                {(['SETTLE', 'REVERSE'] as const).map((option) => (
                  <label key={option} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="resolution"
                      checked={deemedForm.resolution === option}
                      onChange={() => setDeemedForm((f) => ({ ...f, resolution: option }))}
                    />
                    {option === 'SETTLE'
                      ? 'Settle — the money did reach them'
                      : 'Reverse — it did not, return it'}
                  </label>
                ))}
              </div>
              <input
                required
                minLength={3}
                placeholder="Evidence reference — a statement line, a rail ticket number"
                value={deemedForm.evidenceRef}
                onChange={(event) =>
                  setDeemedForm((f) => ({ ...f, evidenceRef: event.target.value }))
                }
                className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
              />
              <textarea
                required
                minLength={10}
                rows={2}
                placeholder="Why — at least ten characters"
                value={deemedForm.reason}
                onChange={(event) => setDeemedForm((f) => ({ ...f, reason: event.target.value }))}
                className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
              />
              <Button type="submit" disabled={resolveDeemed.isPending}>
                {resolveDeemed.isPending ? 'Resolving…' : 'Resolve'}
              </Button>
              {resolveDeemed.isError ? (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {resolveDeemed.error instanceof Error
                    ? resolveDeemed.error.message
                    : 'That did not work.'}
                </p>
              ) : null}
            </form>
          ) : null}

          {isRiskHeld ? (
            <form
              className="mt-6 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                resolveRisk.mutate();
              }}
            >
              <h3 className="text-sm font-semibold">Release or block the hold</h3>
              <div className="flex gap-4 text-sm">
                {(['RELEASE', 'BLOCK'] as const).map((option) => (
                  <label key={option} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="risk"
                      checked={riskForm.decision === option}
                      onChange={() => setRiskForm((f) => ({ ...f, decision: option }))}
                    />
                    {option === 'RELEASE' ? 'Release and send' : 'Block permanently'}
                  </label>
                ))}
              </div>
              <textarea
                required
                minLength={10}
                rows={2}
                placeholder="Why — what you checked, and with whom"
                value={riskForm.reason}
                onChange={(event) => setRiskForm((f) => ({ ...f, reason: event.target.value }))}
                className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
              />
              <Button type="submit" disabled={resolveRisk.isPending}>
                {resolveRisk.isPending ? 'Applying…' : 'Apply'}
              </Button>
              {resolveRisk.isError ? (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {resolveRisk.error instanceof Error
                    ? resolveRisk.error.message
                    : 'That did not work.'}
                </p>
              ) : null}
            </form>
          ) : null}

          {refundable ? (
            <form
              className="mt-6 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                refund.mutate();
              }}
            >
              <h3 className="text-sm font-semibold">Force a refund</h3>
              <p className="text-muted-foreground text-xs">
                Amount in minor units — paise, not rupees. Bounded server-side by what remains
                refundable, so an over-refund is refused rather than posted.
              </p>
              <input
                required
                inputMode="numeric"
                pattern="[0-9]+"
                placeholder={`Minor units (up to ${txn.sourceAmountMinor})`}
                value={refundForm.amountMinor}
                onChange={(event) =>
                  setRefundForm((f) => ({
                    ...f,
                    amountMinor: event.target.value.replace(/[^0-9]/g, ''),
                  }))
                }
                className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
              />
              {refundForm.amountMinor ? (
                <p className="text-muted-foreground text-xs">
                  That is {formatMoney(refundForm.amountMinor, txn.sourceCurrency)}
                </p>
              ) : null}
              <textarea
                required
                minLength={10}
                rows={2}
                placeholder="Why — at least ten characters"
                value={refundForm.reason}
                onChange={(event) => setRefundForm((f) => ({ ...f, reason: event.target.value }))}
                className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
              />
              <Button type="submit" variant="destructive" disabled={refund.isPending}>
                {refund.isPending ? 'Refunding…' : 'Refund'}
              </Button>
              {refund.isError ? (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {refund.error instanceof Error ? refund.error.message : 'That did not work.'}
                </p>
              ) : null}
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

