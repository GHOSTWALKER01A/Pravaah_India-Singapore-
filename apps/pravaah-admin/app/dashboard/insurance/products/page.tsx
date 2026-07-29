'use client';

import { useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { insuranceAdminService } from '@/lib/api/insurance/insurance.service';
import type {
  AdminProduct,
  InsuranceProductType,
  UpsertProductRequest,
} from '@/lib/api/insurance/insurance.schema';

/**
 * The catalogue.
 *
 * ## Why a product is retired and never deleted
 *
 * Policies sold on a product have to keep resolving their terms for as long as a claim can be
 * filed against them — ninety days after an incident, on a policy that may run a year. A deleted
 * catalogue row would leave a live policy pointing at nothing, and the claim it was sold to cover
 * would become unassessable. So `isActive` is a flag, the policy count is shown beside it, and
 * there is no delete control on this page at all.
 *
 * ## Why the base rate is displayed as a worked example
 *
 * `900 bps` is meaningless to anybody who does not already know it is annual and of coverage. The
 * row shows what a STANDARD-risk applicant would actually pay on the midpoint of the cover band,
 * because that is the number an operator can sanity-check against what they think the product
 * costs. A rate nobody can check is a rate that stays wrong.
 */
export default function InsuranceProductsPage() {
  const client = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const products = useQuery({
    queryKey: ['insurance-products'],
    queryFn: () => insuranceAdminService.products(),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      insuranceAdminService.setProductActive(id, isActive),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['insurance-products'] });
      void client.invalidateQueries({ queryKey: ['insurance-stats'] });
    },
  });

  const rows = products.data ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The cover catalogue. Adding a product needs no deploy — but every rate here decides
            what a policyholder pays, so each one is checkable below.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowForm((open) => !open)}
        >
          {showForm ? 'Close' : 'Add a cover'}
        </Button>
      </header>

      {showForm ? (
        <NewProductForm
          onDone={() => {
            setShowForm(false);
            void client.invalidateQueries({ queryKey: ['insurance-products'] });
          }}
        />
      ) : null}

      {products.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading the catalogue…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-black/10 p-4 text-sm dark:border-white/10">
          The catalogue is empty, so the marketplace shows nothing. Run{' '}
          <code className="font-mono">npm run prisma:seed</code> for the three shipped covers, or
          add one above.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onToggle={() =>
                setActive.mutate({
                  id: product.id,
                  isActive: !product.isActive,
                })
              }
              toggling={setActive.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductCard({
  product,
  onToggle,
  toggling,
}: {
  product: AdminProduct;
  onToggle: () => void;
  toggling: boolean;
}) {
  /**
   * The exclusions, narrowed at the boundary.
   *
   * `exclusions` is `Json` in the database and therefore `unknown` on the wire. Narrowing it here
   * rather than asserting `string[]` in the schema is the honest option: the column genuinely
   * permits any JSON, and a product seeded or edited outside this form could hold something else.
   * Non-strings are dropped rather than stringified — an exclusion a policyholder cannot read is
   * not an exclusion, and showing `[object Object]` in a list that decides claims would be worse
   * than showing nothing.
   */
  const exclusions = Array.isArray(product.exclusions)
    ? product.exclusions.filter(
        (line): line is string => typeof line === 'string',
      )
    : [];

  return (
    <article
      className={`rounded-md border p-4 ${
        product.isActive
          ? 'border-black/10 dark:border-white/10'
          : 'border-black/10 opacity-60 dark:border-white/10'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{product.name}</h2>
          <p className="text-muted-foreground text-xs">
            {product.type.replace(/_/g, ' ').toLowerCase()} · {product.currency} · added{' '}
            {new Date(product.createdAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs ${
              product.isActive
                ? 'text-green-600 dark:text-green-400'
                : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            {product.isActive ? 'on offer' : 'retired'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggle}
            disabled={toggling}
          >
            {product.isActive ? 'Retire' : 'Put back on offer'}
          </Button>
        </div>
      </div>

      {product.tagline ? (
        <p className="mt-2 text-sm">{product.tagline}</p>
      ) : null}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label="Cover band"
          value={`${product.minCover.formatted} – ${product.maxCover.formatted}`}
        />
        <Fact
          label="Base rate"
          value={`${product.baseRateBps} bps / year`}
          /*
            The worked example.

            `900 bps` tells an operator nothing on its own. What a standard-risk applicant pays
            on the midpoint of the band is a number they can hold against their own sense of
            what this product costs — and an error of a factor of ten becomes obvious.
          */
          note={workedExample(product)}
        />
        <Fact
          label="Waiting period"
          value={
            product.waitingPeriodDays === 0
              ? 'none'
              : `${product.waitingPeriodDays} days`
          }
          note={
            product.waitingPeriodDays === 0
              ? 'only defensible on a single-trip product'
              : 'the anti-adverse-selection control'
          }
        />
        <Fact
          label="Term / free look"
          value={`${product.termDays} days / ${product.freeLookDays} days`}
        />
      </dl>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-medium">
          Exclusions ({exclusions.length}) and disclaimer
        </summary>
        <ul className="mt-2 space-y-1">
          {exclusions.map((line) => (
            <li key={line} className="flex gap-2 text-xs">
              <span className="text-muted-foreground mt-1.5 h-px w-2 shrink-0 bg-current" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-3 text-xs">{product.disclaimer}</p>
      </details>
    </article>
  );
}

/**
 * What a STANDARD-risk applicant pays on the midpoint of the cover band.
 *
 * An ILLUSTRATION, and labelled as one with `≈`. The authoritative premium is always the server's,
 * computed in `BigInt` through `computePremium`; this is a sanity check so an operator can catch a
 * base rate that is wrong by a factor of ten before it is offered to anybody.
 *
 * ## Why `Number` is acceptable here when `money.ts` forbids it
 *
 * `money.ts` refuses `Number()` on a minor-unit string because the values it handles are
 * CUMULATIVE — a trial-balance net, a ledger total — and those genuinely exceed 2^53. A single
 * product's cover band cannot: the largest plausible sum insured is a few crore in paise (~1e10),
 * and multiplying by a rate capped at 5000bps stays under 1e14, comfortably inside the safe
 * integer range. The guard below enforces that rather than assuming it, and bails out to a plain
 * description rather than printing a silently-rounded figure.
 *
 * There is no `BigInt` because this app targets ES2017, which has no literals for it.
 */
const SAFE_MINOR_DIGITS = 13;

function workedExample(product: AdminProduct): string {
  const minDigits = product.minCover.minor.replace(/[^0-9]/g, '');
  const maxDigits = product.maxCover.minor.replace(/[^0-9]/g, '');

  /**
   * Refuse rather than round.
   *
   * A cover band wide enough to overflow a double is not a product anybody is selling — it is a
   * data error, and printing a plausible-looking premium for it would hide exactly the mistake
   * this illustration exists to catch.
   */
  if (
    minDigits.length > SAFE_MINOR_DIGITS ||
    maxDigits.length > SAFE_MINOR_DIGITS ||
    maxDigits.length === 0
  ) {
    return 'annual, in basis points of coverage';
  }

  const mid = Math.floor((Number(minDigits) + Number(maxDigits)) / 2);

  // coverage × bps / 10_000, rounded UP exactly as `computePremium` does on the server.
  const annual = Math.ceil((mid * product.baseRateBps) / 10_000);

  // Monthly beyond 90 days of term, otherwise pro-rated to the term — the same split
  // `frequencyFor` applies on the server, so the illustration matches the real quote's shape.
  const monthly = product.termDays > 90;
  const period = monthly
    ? Math.ceil(annual / 12)
    : Math.ceil((annual * product.termDays) / 365);

  const symbol = product.currency === 'INR' ? '₹' : 'S$';
  const whole = Math.floor(period / 100);
  const minor = String(period % 100).padStart(2, '0');

  return `≈ ${symbol}${whole.toLocaleString(
    product.currency === 'INR' ? 'en-IN' : 'en-SG',
  )}.${minor}${monthly ? '/mo' : ' once'} at standard risk, mid-band`;
}

function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
      {note ? (
        <dd className="text-muted-foreground text-xs">{note}</dd>
      ) : null}
    </div>
  );
}

const TYPES: InsuranceProductType[] = [
  'INCOME_PROTECTION',
  'HEALTH_TOPUP',
  'TRAVEL_ACCIDENT',
];

/**
 * Add a cover.
 *
 * The form deliberately does NOT re-implement the server's cross-field rules. It sends the
 * payload and shows the server's 400 verbatim, because the server refuses the products that would
 * be unsafe to sell — a waiting period longer than the term could never pay a claim, and a zero
 * waiting period on income protection makes buying after the incident rational — and a second
 * copy of those rules here would eventually disagree with the one that is enforced.
 */
function NewProductForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<UpsertProductRequest>({
    type: 'INCOME_PROTECTION',
    name: '',
    tagline: '',
    currency: 'INR',
    baseRateBps: 900,
    minCoverMinor: '500000',
    maxCoverMinor: '5000000',
    termDays: 365,
    waitingPeriodDays: 30,
    freeLookDays: 15,
    exclusions: [''],
    disclaimer:
      'Pravaah provides information, not medical or financial advice. Cover, exclusions, waiting periods and claim decisions are governed by the insurer’s policy wording.',
    isActive: true,
  });

  const create = useMutation({
    mutationFn: () =>
      insuranceAdminService.createProduct({
        ...form,
        exclusions: form.exclusions
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        tagline: form.tagline?.trim() || undefined,
      }),
    onSuccess: onDone,
  });

  const set = <K extends keyof UpsertProductRequest>(
    key: K,
    value: UpsertProductRequest[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
      className="space-y-4 rounded-md border border-black/10 p-4 dark:border-white/10"
    >
      <h2 className="text-sm font-semibold">New cover</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <select
            value={form.type}
            onChange={(event) =>
              set('type', event.target.value as InsuranceProductType)
            }
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Currency">
          <select
            value={form.currency}
            onChange={(event) => set('currency', event.target.value)}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          >
            <option value="INR">INR</option>
            <option value="SGD">SGD</option>
          </select>
        </Field>

        <Field label="Name" className="sm:col-span-2">
          <input
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            required
            minLength={3}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          />
        </Field>

        <Field
          label="Who it is for"
          className="sm:col-span-2"
          note="One plain sentence. This is the only line a first-time buyer reads."
        >
          <input
            value={form.tagline ?? ''}
            onChange={(event) => set('tagline', event.target.value)}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          />
        </Field>

        <Field
          label="Base rate (bps/year of coverage)"
          note="900 = 9% of the sum insured per year at standard risk."
        >
          <input
            type="number"
            min={10}
            max={5000}
            value={form.baseRateBps}
            onChange={(event) => set('baseRateBps', Number(event.target.value))}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
          />
        </Field>

        <Field label="Term (days)">
          <input
            type="number"
            min={1}
            max={3650}
            value={form.termDays}
            onChange={(event) => set('termDays', Number(event.target.value))}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
          />
        </Field>

        <Field label="Minimum cover (minor units)">
          <input
            value={form.minCoverMinor}
            onChange={(event) =>
              set('minCoverMinor', event.target.value.replace(/[^0-9]/g, ''))
            }
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
          />
        </Field>

        <Field label="Maximum cover (minor units)">
          <input
            value={form.maxCoverMinor}
            onChange={(event) =>
              set('maxCoverMinor', event.target.value.replace(/[^0-9]/g, ''))
            }
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
          />
        </Field>

        <Field
          label="Waiting period (days)"
          note="Zero is only accepted on TRAVEL_ACCIDENT — a single trip has no window to sit on a known loss."
        >
          <input
            type="number"
            min={0}
            max={365}
            value={form.waitingPeriodDays}
            onChange={(event) =>
              set('waitingPeriodDays', Number(event.target.value))
            }
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
          />
        </Field>

        <Field label="Free look (days)">
          <input
            type="number"
            min={0}
            max={30}
            value={form.freeLookDays}
            onChange={(event) => set('freeLookDays', Number(event.target.value))}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 font-mono text-sm dark:border-white/15"
          />
        </Field>

        <Field
          label="Exclusions"
          className="sm:col-span-2"
          note="One per line, in plain words. These decide claims, and the person reading them has little insurance literacy."
        >
          <textarea
            value={form.exclusions.join('\n')}
            onChange={(event) => set('exclusions', event.target.value.split('\n'))}
            rows={5}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          />
        </Field>

        <Field label="Disclaimer" className="sm:col-span-2">
          <textarea
            value={form.disclaimer}
            onChange={(event) => set('disclaimer', event.target.value)}
            rows={3}
            className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/15"
          />
        </Field>
      </div>

      {create.isError ? (
        /*
          The server's own refusal, verbatim.

          Its cross-field messages name the actual hazard — "the waiting period must be shorter
          than the term, or no claim could ever be paid" — and replacing that with "invalid input"
          would discard the one sentence that explains why the product was rejected.
        */
        <p className="text-sm text-red-600 dark:text-red-400">
          {create.error instanceof Error
            ? create.error.message
            : 'That product could not be created.'}
        </p>
      ) : null}

      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create this cover'}
      </Button>
    </form>
  );
}

function Field({
  label,
  note,
  className = '',
  children,
}: {
  label: string;
  note?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`.trim()}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="mt-1">{children}</div>
      {note ? (
        <span className="text-muted-foreground mt-1 block text-xs">{note}</span>
      ) : null}
    </label>
  );
}
