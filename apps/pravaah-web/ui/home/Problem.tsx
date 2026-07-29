import type { ReactElement } from "react";

import { Container } from "@/ui/layout/Container";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The problem, told as one person rather than as a market. PRODUCT.md's
 * primary user is Ravi; this section is the reason he is reading at all.
 *
 * Composition is deliberately a two-column ledger — before the border and
 * after it — because the loss is a comparison, and a comparison is the one
 * thing a card grid cannot show.
 */

const BEFORE: readonly string[] = [
  "A salary paid into the same account for years",
  "Rent and bills settled on time, every month",
  "A credit file a bank will lend against",
  "Insurance priced on a record, not a guess",
];

const AFTER: readonly string[] = [
  "No local credit file — so no loan",
  "No proof of rent history — so a punitive deposit, or a refusal",
  "An unknown risk to every insurer — so the newcomer premium",
  "Years of good behaviour that count for nothing",
];

export function Problem(): ReactElement {
  return (
    <section className="border-b border-intaglio/12 bg-rag py-20 sm:py-28">
      <Container>
        <div className="max-w-3xl">
          <Legend className="text-intaglio-mid" rule>
            The problem
          </Legend>
          <h2 className="denomination mt-8 text-[2.25rem] text-intaglio-deep sm:text-5xl lg:text-[3.5rem]">
            Reputation stops at the border. Nothing about that is technical.
          </h2>
          <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
            Ravi worked in India for years. His bank trusts him, his landlord
            renewed without asking, his insurer knows his record. He takes a job
            in Singapore, and on the day he lands he becomes a stranger to every
            institution there. Not because anything changed about him — because
            his evidence could not travel.
          </p>
        </div>

        <div className="mt-16 grid gap-px border border-intaglio/20 bg-intaglio/20 sm:mt-20 sm:grid-cols-2">
          <div className="bg-rag p-7 sm:p-10">
            <Legend className="text-intaglio-mid">In India · before</Legend>
            <ul className="mt-7 flex flex-col gap-4">
              {BEFORE.map((item) => (
                <li
                  key={item}
                  className="flex gap-3.5 text-[0.9375rem] leading-relaxed text-ink"
                >
                  <span
                    aria-hidden="true"
                    className="mt-[0.7em] h-px w-3 shrink-0 bg-intaglio-mid"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* The second colour carries the loss. This is the iris print doing
              its job: the fact the reader must not skim past. */}
          <div className="bg-rag-shade/60 p-7 sm:p-10">
            <Legend className="text-carmine">
              In Singapore · the day after
            </Legend>
            <ul className="mt-7 flex flex-col gap-4">
              {AFTER.map((item) => (
                <li
                  key={item}
                  className="flex gap-3.5 text-[0.9375rem] leading-relaxed text-ink"
                >
                  <span
                    aria-hidden="true"
                    className="mt-[0.7em] h-px w-3 shrink-0 bg-carmine"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-12 max-w-2xl text-base leading-relaxed text-intaglio sm:text-lg">
          This happens to millions of migrant workers, students and founders
          every year. MyPravaah exists so that the record you built is yours to
          carry — not an asset stranded in a database you left behind.
        </p>
      </Container>
    </section>
  );
}
