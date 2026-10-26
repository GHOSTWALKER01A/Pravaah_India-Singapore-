import type { ReactElement } from "react";

import { SEQUENCE } from "@/lib/content/identity-checks";
import { cn } from "@/lib/utils";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The applicant's real sequence.
 *
 * The check list and its order come from apps/pravaah-rn/src/features/kyc —
 * this page promises a sequence, so it renders the one that ships rather than
 * a generic KYC list. There is one sequence, because there is one market: the
 * corridor selector that used to sit above this list went with Singapore.
 *
 * Numbered, because the order is enforced: a failed PAN keeps you on PAN and
 * the flow never skips ahead of an unverified step.
 */
/**
 * The plate above the sequence — the same three-panel engraved grid the
 * corridor selector used, kept because it is part of the page's composition.
 * It is static now: one market, one sequence, so the first panel is struck in
 * the field colour as the only state there is.
 */
const PLATE: ReadonlyArray<{ label: string; value: string; body: string }> = [
  {
    label: "India",
    value: `${SEQUENCE.length} steps`,
    body: "You hold a PAN, an Aadhaar record and an Indian bank account in your own name.",
  },
  {
    label: "Documents",
    value: "None",
    body: "Nothing is scanned or uploaded. Every record is pulled from the authority that holds it.",
  },
  {
    label: "Next lender",
    value: "No repeat",
    body: "Verified once. Your reputation receipt carries it to every partner after that.",
  },
];

export function CheckSequence(): ReactElement {
  return (
    <div>
      <Legend className="text-intaglio-mid">Who this is for</Legend>

      <div className="mt-5 grid gap-px border border-intaglio/25 bg-intaglio/25 sm:grid-cols-3">
        {PLATE.map((entry, index) => {
          const struck = index === 0;
          return (
            <div
              key={entry.label}
              className={cn(
                "flex h-full flex-col gap-2 p-6",
                struck ? "bg-intaglio text-reverse" : "bg-rag",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                <span
                  className={cn(
                    "denomination text-2xl",
                    struck ? "text-reverse" : "text-intaglio-deep",
                  )}
                >
                  {entry.label}
                </span>
                <span
                  className={cn(
                    "field-value text-xs",
                    struck ? "text-latent" : "text-intaglio-mid",
                  )}
                >
                  {entry.value}
                </span>
              </span>
              <span
                className={cn(
                  "text-sm leading-relaxed",
                  struck ? "text-reverse-dim" : "text-intaglio-mid",
                )}
              >
                {entry.body}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-14 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-b border-intaglio/25 pb-4">
        <Legend className="text-intaglio-mid">
          {SEQUENCE.length} required checks, in order
        </Legend>
        <Legend className="text-carmine">
          Every check must clear before you are verified
        </Legend>
      </div>

      <ol className="mt-2">
        {SEQUENCE.map((check, index) => (
          <li
            key={check.id}
            className="grid gap-y-5 border-b border-intaglio/15 py-9 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:gap-x-8 lg:grid-cols-[3.5rem_minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-12"
          >
            <span className="denomination text-3xl text-carmine sm:text-4xl">
              {String(index + 1).padStart(2, "0")}
            </span>

            <div>
              <h3 className="denomination text-[1.375rem] text-intaglio-deep sm:text-2xl">
                {check.label}
              </h3>
              <p className="legend mt-2 text-intaglio-mid">{check.subtitle}</p>
              <p className="mt-5 text-[0.9375rem] leading-relaxed text-ink">
                {check.action}
              </p>
            </div>

            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1 lg:border-l lg:border-intaglio/15 lg:pl-8">
              <div>
                <dt className="legend text-intaglio-mid">What it proves</dt>
                <dd className="mt-2 text-sm leading-relaxed text-ink">
                  {check.proves}
                </dd>
              </div>
              <div className="grid gap-5 sm:grid-cols-1 lg:grid-cols-2">
                <div>
                  <dt className="legend text-intaglio-mid">What you need</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-ink">
                    {check.needs}
                  </dd>
                </div>
                <div>
                  <dt className="legend text-intaglio-mid">Time</dt>
                  <dd className="field-value mt-2 text-sm text-ink">
                    {check.duration}
                  </dd>
                </div>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}
