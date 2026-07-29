import type { ReactElement } from "react";

import { DECISIONS } from "@/lib/content/modules";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The choices that carry the promises.
 *
 * This is the densest section on the site and the only one written for a reader
 * who wants to disagree. It is set as a two-column measure at the widest
 * breakpoint and a single column below, with the module reference set as a
 * serial — deliberately NOT numbered, because the order here carries no
 * information (DESIGN.md permits ordered numbering only where it does).
 *
 * Every entry states the choice and then the failure the obvious alternative
 * produces. That shape is the point: a list of decisions with no counterfactual
 * is a list of assertions, and the counterfactual is the part a sceptical
 * reader can check.
 */
export function Decisions(): ReactElement {
  return (
    <div>
      <div className="max-w-3xl">
        {/* The legend is the issuing line, not the heading. Every section on
            this page keeps its real heading at h2 and its items at h3, so the
            outline a screen reader reads is the one the page looks like. */}
        <Legend className="text-intaglio-mid" rule>
          Decisions worth defending
        </Legend>
        <h2 className="denomination mt-8 text-[2rem] text-intaglio-deep sm:text-[2.75rem]">
          Each of these is somewhere the obvious implementation breaks a promise
          made on another page.
        </h2>
        <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
          Not a list of clever details. Every entry below is a place where the
          straightforward version would have quietly failed a person — leaked a
          score band, refunded a payment that settled, rejected a name that was
          correct, or told somebody they were uninsured on a day they could still
          claim.
        </p>
      </div>

      <ul className="mt-16 grid gap-x-16 gap-y-12 lg:grid-cols-2">
        {DECISIONS.map((decision) => (
          <li key={decision.title} className="min-w-0">
            <span className="field-value block text-xs text-carmine">
              {decision.module}
            </span>
            <h3 className="denomination mt-2.5 max-w-lg text-xl text-intaglio-deep sm:text-2xl">
              {decision.title}
            </h3>
            <p className="mt-3.5 max-w-xl text-[0.9375rem] leading-relaxed text-ink">
              {decision.body}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
