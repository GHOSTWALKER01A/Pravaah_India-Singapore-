import type { ReactElement } from "react";

import { Container } from "@/ui/layout/Container";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The problem, told as one person rather than as a market. PRODUCT.md's
 * primary user is Rekha — an illustrative persona, not a customer — and this
 * section is the reason she is reading at all.
 *
 * Composition is deliberately a two-column ledger — what her own payments show
 * and what the bureau sees — because the gap is a comparison, and a comparison
 * is the one thing a card grid cannot show.
 */

const PAYMENTS: readonly string[] = [
  "Eleven months of daily settlements at her counter",
  "Inflows that held steady through the slow months",
  "Suppliers paid on time, every week",
  "A record that already exists — behind her consent",
];

const BUREAU: readonly string[] = [
  "No credit card, no loan history — a thin file",
  "A document list she cannot satisfy",
  "One application refused, and no reason given",
  "Eleven months of good behaviour that count for nothing",
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
            A thin file is not bad credit. It is unmeasured.
          </h2>
          <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
            Rekha runs a small kirana counter and takes her payments over UPI.
            She has no credit card and needs ₹40,000 for festival stock. She
            applied once: they asked for documents she does not have, then said
            no, and nobody told her why. Not because anything is wrong with her
            record — because no one asked for it in a form she could give.
          </p>
        </div>

        <div className="mt-16 grid gap-px border border-intaglio/20 bg-intaglio/20 sm:mt-20 sm:grid-cols-2">
          <div className="bg-rag p-7 sm:p-10">
            <Legend className="text-intaglio-mid">What her payments show</Legend>
            <ul className="mt-7 flex flex-col gap-4">
              {PAYMENTS.map((item) => (
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
            <Legend className="text-carmine">What the bureau sees</Legend>
            <ul className="mt-7 flex flex-col gap-4">
              {BUREAU.map((item) => (
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
          This happens to gig workers, small merchants and first-time borrowers
          every day. MyPravaah exists so that the record you already built is
          yours to show — once, with consent, and with the reasons attached.
        </p>
      </Container>
    </section>
  );
}
