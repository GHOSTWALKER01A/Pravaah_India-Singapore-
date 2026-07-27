import type { ReactElement } from "react";

import { CHAIN, DOWNSTREAM } from "@/lib/content/chain";
import { Container } from "@/ui/layout/Container";
import { Legend } from "@/ui/primitives/Legend";
import { StatusMark } from "@/ui/primitives/StatusMark";

/**
 * The chain of trust.
 *
 * These are numbered because the order carries information the reader needs:
 * each link is impossible without the one before it. That dependency is the
 * whole architecture, so it is stated in the link between rows rather than
 * left for the reader to infer.
 *
 * Every roadmap module is marked as roadmap — PRODUCT.md requires it, and for
 * this audience the honesty is itself the argument.
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
            This is why Pravaah is built in order rather than as a set of
            features. An unverified identity cannot produce consented data; data
            nobody consented to cannot produce a score; a score with no data
            behind it cannot be sealed into anything worth presenting. Two links
            are in service today.
          </p>
        </div>

        <ol className="mt-16 sm:mt-20">
          {CHAIN.map((link, index) => (
            <li
              key={link.id}
              className="relative grid gap-y-4 border-t border-intaglio/20 py-8 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-x-8 sm:py-10 lg:grid-cols-[7rem_minmax(0,22rem)_minmax(0,1fr)] lg:gap-x-12"
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
                <StatusMark status={link.status} className="mt-4" />
              </div>

              <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-ink sm:text-base">
                {link.detail}
              </p>
            </li>
          ))}
        </ol>

        {/* Downstream of the passport. Kept visually subordinate because it is
            subordinate: PRODUCT.md is explicit that payments are one module of
            eight and not the point of the product. */}
        <div className="mt-20 border-t-2 border-intaglio pt-14 sm:mt-24">
          <div className="max-w-3xl">
            <Legend className="text-intaglio-mid">
              Downstream · once the passport exists
            </Legend>
            <p className="mt-6 text-base leading-relaxed text-intaglio sm:text-lg">
              Sending money across the corridor is genuinely useful — and it is
              one module of eight, worth something only because of the trust
              built above it. Without the passport it is just another payments
              app.
            </p>
          </div>

          <dl className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-3">
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
                  <StatusMark status={item.status} className="mt-4" />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Container>
    </section>
  );
}
