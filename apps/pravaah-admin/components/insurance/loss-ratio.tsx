import type { BookCurrency } from '@/lib/api/insurance/insurance.schema';
import { formatMoney } from '@/lib/api/payments/money';

/**
 * The loss ratio, per currency. The one number an insurer judge looks for.
 *
 * ## Why this is a banner and not a tile in a row of four
 *
 * `components/payments/figure.tsx` states the console's rule: a genuine alarm is a banner with a
 * sentence, not a number in a box. A loss ratio over 100% means the book is paying out more than
 * it earns — a pricing decision to revisit, not a queue to work through — and a reader who has
 * learned that amber tiles are the normal state would scroll past it.
 *
 * ## Why there is no combined total
 *
 * Adding INR paise to SGD cents produces a number that means nothing, and a "combined loss
 * ratio" would be the most confidently wrong figure on the dashboard. Same reasoning as M4's
 * trial balance, which is also strictly per-currency. The server sends a `note` saying so and it
 * is rendered verbatim — an operator expecting a headline figure is owed the reason it is absent.
 *
 * ## Why a null ratio is not 0%
 *
 * A book with no earned premium has NO loss ratio. `0%` would read as a perfectly performing
 * product that has simply never sold anything, which is the opposite of what it means.
 */
export function LossRatioBanner({ row }: { row: BookCurrency }) {
  const ratio = row.lossRatioPercent;
  const deficit = row.underwritingResult === 'DEFICIT';

  /**
   * Three states, and the thresholds are the ones an actuary would use.
   *
   * Under 70% is a healthy book. 70–100% is thin but solvent — worth watching, not worth
   * alarming about. Over 100% means claims have outrun premiums.
   */
  const level =
    ratio === null
      ? 'idle'
      : ratio > 100
        ? 'loss'
        : ratio >= 70
          ? 'thin'
          : 'healthy';

  const frame =
    level === 'loss'
      ? 'border-red-500/60 bg-red-50/50 dark:bg-red-950/20'
      : level === 'thin'
        ? 'border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20'
        : 'border-black/10 dark:border-white/10';

  const figureTone =
    level === 'loss'
      ? 'text-red-700 dark:text-red-400'
      : level === 'thin'
        ? 'text-amber-700 dark:text-amber-400'
        : '';

  return (
    <section className={`rounded-md border p-4 ${frame}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Loss ratio · {row.currency}
          </div>
          <div className={`mt-1 font-mono text-3xl ${figureTone}`}>
            {ratio === null ? '—' : `${ratio.toFixed(2)}%`}
          </div>
        </div>

        <div className="text-right">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Underwriting position
          </div>
          <div
            className={`mt-1 font-mono text-2xl ${
              deficit ? 'text-red-700 dark:text-red-400' : ''
            }`}
          >
            {formatMoney(row.floatBalanceMinor, row.currency)}
          </div>
          <div className="text-muted-foreground text-xs">
            {deficit ? 'deficit — claims exceed premiums' : 'surplus'}
          </div>
        </div>
      </div>

      {/* The sentence. This is what makes it a banner rather than a tile. */}
      <p className="mt-3 text-sm">
        {level === 'idle'
          ? 'No premium has been earned in this currency yet, so there is no loss ratio to report. This is not zero — it is undefined.'
          : level === 'loss'
            ? `Claims paid exceed premium earned. The float is negative by design rather than blocked: an approved claim is paid even when the book is thin, because refusing it would be the insurer failing its own policyholder to keep a number tidy. Revisit the base rate or the band multipliers.`
            : level === 'thin'
              ? 'The book is solvent but thin. Worth watching rather than acting on — a single large claim moves this figure sharply at low volume.'
              : 'The book is earning more than it pays out.'}
      </p>

      {/* ── the two halves of the ratio, so it can be checked ────────────────── */}
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <Half
          label="Premium earned"
          value={row.netEarnedPremium.formatted}
          note={
            row.refundedPremium.minor === '0'
              ? 'the denominator'
              : `net of ${row.refundedPremium.formatted} refunded`
          }
        />
        <Half
          label="Claims paid"
          value={row.claimsPaid.formatted}
          note="the numerator"
        />
        <Half
          label="Gross premium"
          value={row.earnedPremium.formatted}
          note="before free-look refunds"
        />
      </dl>
    </section>
  );
}

function Half({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
      <dd className="text-muted-foreground text-xs">{note}</dd>
    </div>
  );
}

/**
 * Where these figures come from, said once on the page.
 *
 * It matters because it is the claim that makes the loss ratio trustworthy: it is derived from
 * LEDGER ENTRIES, not from `PremiumPayment.status` and `Claim.amountApprovedMinor`. The
 * application tables record what we intended; the ledger records what moved. So this figure
 * reconciles against M4's trial balance, and an operator can check it there.
 */
export function BookProvenanceNote({ note }: { note: string }) {
  return (
    <p className="text-muted-foreground rounded-md border border-black/10 p-3 text-xs dark:border-white/10">
      {note}
    </p>
  );
}
