import type { ReactElement } from "react";

import { SECURITY_FEATURES } from "@/lib/content/security";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The load-bearing section of the site: a banknote's anti-forgery vocabulary
 * set beside the mechanism it corresponds to.
 *
 * It is a two-column ledger rather than a card grid because the whole point is
 * the correspondence — printed feature on the left, real mechanism on the
 * right. Break that pairing and the section says nothing.
 *
 * There is no status mark on a row any more. Every mechanism here is built, so
 * eight identical badges added a column of noise while implying the reader
 * should be hunting for the exceptions. Stage is stated once for the product,
 * where it can be read rather than counted.
 */
export function FeatureLedger(): ReactElement {
  return (
    <div>
      <Legend as="h2" className="text-latent" rule>
        Read as a note reads
      </Legend>

      <p className="mt-8 max-w-2xl text-base leading-relaxed text-reverse-dim sm:text-lg">
        A banknote works because anyone can check it and nobody can forge it,
        and it is carried by whoever holds it. This credential is built on the
        same principles. Each printed feature below has a direct counterpart in
        how MyPravaah works.
      </p>

      <dl className="mt-14 border-t border-reverse/20">
        {SECURITY_FEATURES.map((feature) => (
          <div
            key={feature.printed}
            className="grid gap-y-6 border-b border-reverse/15 py-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-x-16"
          >
            <dt>
              <span className="denomination block text-2xl text-latent sm:text-[1.75rem]">
                {feature.printed}
              </span>
              <span className="mt-4 block max-w-sm text-sm leading-relaxed text-reverse-dim">
                {feature.onTheNote}
              </span>
            </dt>

            <dd>
              <span className="denomination block text-xl text-reverse sm:text-2xl">
                {feature.mechanism}
              </span>
              <p className="mt-4 max-w-2xl text-[0.9375rem] leading-relaxed text-reverse sm:text-base">
                {feature.detail}
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
