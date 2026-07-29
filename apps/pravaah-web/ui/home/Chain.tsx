import type { ReactElement } from "react";

import { STAGE } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { CHAIN, DOWNSTREAM } from "@/lib/content/chain";
import { ButtonLink } from "@/ui/primitives/Button";
import { Container } from "@/ui/layout/Container";
import { Legend } from "@/ui/primitives/Legend";
import { RailMark, StatusMark } from "@/ui/primitives/StatusMark";

/**
 * The chain of trust.
 *
 * These are numbered because the order carries information the reader needs:
 * each link is impossible without the one before it. That dependency is the
 * whole architecture, so it is stated in the link between rows rather than
 * left for the reader to infer.
 *
 * Every row now reads "Built · verified", and the uniformity is the argument
 * rather than a formatting accident — a reader arriving at a page like this
 * expects most of it to be roadmap. What still varies is whether the regulated
 * rail behind a link is the real one, so that is marked separately and the
 * limitation is printed in full underneath. Marking the two on one axis would
 * be the dishonest shortcut available here.
 */
export function Chain(): ReactElement {
  return (
    <section className="border-b border-intaglio/12 bg-rag py-20 sm:py-28">
      <Container>
        <div className="max-w-3xl">
          <Legend className="text-intaglio-mid" rule>
            The chain of trust
          </Legend>
          <h2 className="denomination mt-8 text-[2.25rem] text-intaglio-deep sm:text-5xl lg:text-[3.5rem]">
            Each link is impossible without the one above it.
          </h2>
          <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
            This is why MyPravaah is built in order rather than as a set of
            features. An unverified identity cannot produce consented data; data
            nobody consented to cannot produce a score; a score with no data
            behind it cannot be sealed into anything worth presenting. All of it
            is built — and the point of the order is that no link can be
            skipped, not that some are still missing.
          </p>
        </div>

        <ol className="mt-16 sm:mt-20">
          {CHAIN.map((link, index) => (
            <li
              key={link.id}
              className="relative grid gap-y-5 border-t border-intaglio/20 py-8 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-8 sm:py-10 lg:grid-cols-[7rem_minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-12"
            >
              <div className="flex items-baseline gap-3 sm:flex-col sm:gap-2">
                <span className="field-value text-sm text-carmine">
                  {link.id}
                </span>
                {/* The dependency arrow: what makes this a chain and not a
                    list. Suppressed on the first link, which depends on
                    nothing. */}
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className="legend text-intaglio-mid/70 sm:mt-1"
                  >
                    ↑ needs {CHAIN[index - 1].id}
                  </span>
                ) : null}
              </div>

              <div>
                <h3 className="denomination text-2xl text-intaglio-deep sm:text-[1.75rem]">
                  {link.name}
                </h3>
                <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-carmine">
                  {link.claim}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <StatusMark status={link.status} />
                  <RailMark rail={link.rail} />
                </div>
              </div>

              <div className="max-w-2xl">
                <p className="text-[0.9375rem] leading-relaxed text-ink sm:text-base">
                  {link.detail}
                </p>

                {/* What the holder does. Kept as a distinct field rather than
                    folded into the paragraph above: the mechanism and the
                    experience answer different questions, and a reader
                    scanning for "what will this ask of me" should not have to
                    read an architecture note to find it. */}
                <p className="mt-4 border-l border-intaglio/25 pl-4 text-[0.9375rem] leading-relaxed text-intaglio">
                  <span className="legend mb-1 block text-intaglio-mid">
                    What you do
                  </span>
                  {link.holder}
                </p>

                {link.caveat ? (
                  <p className="mt-4 text-sm leading-relaxed text-carmine-deep">
                    {link.caveat}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        {/* Downstream of the passport. Kept visually subordinate because it is
            subordinate: PRODUCT.md is explicit that payments are one module of
            eight and not the point of the product. */}
        <div className="mt-20 border-t-2 border-intaglio pt-14 sm:mt-24">
          <div className="max-w-3xl">
            <Legend className="text-intaglio-mid">
              Downstream · what the passport is worth
            </Legend>
            <p className="mt-6 text-base leading-relaxed text-intaglio sm:text-lg">
              Sending money across the corridor, buying cover priced on your
              record, and being protected from someone impersonating you are all
              genuinely useful. Each is one module of eight, and each is worth
              something only because of the trust built above it. Without the
              passport, they are another payments app.
            </p>
          </div>

          <dl className="mt-12 grid gap-x-12 gap-y-12 sm:grid-cols-3">
            {DOWNSTREAM.map((item) => (
              <div key={item.id}>
                <dt>
                  <span className="field-value block text-xs text-intaglio-mid">
                    {item.id}
                  </span>
                  <span className="denomination mt-2 block text-xl text-intaglio-deep">
                    {item.name}
                  </span>
                </dt>
                <dd>
                  <p className="mt-2 text-sm leading-relaxed text-carmine">
                    {item.claim}
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-ink">
                    {item.detail}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <StatusMark status={item.status} />
                    <RailMark rail={item.rail} />
                  </div>
                  {item.caveat ? (
                    <p className="mt-3 text-sm leading-relaxed text-carmine-deep">
                      {item.caveat}
                    </p>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* The stage, stated once, where the reader has just been told eight
            things are built and is entitled to be sceptical. */}
        <div className="mt-20 border border-carmine/30 bg-carmine/5 p-7 sm:mt-24 sm:p-10 notch-lg">
          <Legend className="text-carmine">
            Before you read any of that as an offer
          </Legend>
          <p className="mt-5 max-w-3xl text-base leading-relaxed text-ink sm:text-lg">
            {STAGE.pending}
          </p>
          <p className="mt-4 max-w-3xl text-[0.9375rem] leading-relaxed text-intaglio">
            {STAGE.release}
          </p>
          <ButtonLink
            href={ROUTES.WHAT_IS_BUILT}
            variant="secondary"
            className="mt-8"
          >
            See exactly what is built
          </ButtonLink>
        </div>
      </Container>
    </section>
  );
}
