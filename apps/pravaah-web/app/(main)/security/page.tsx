import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";

import { SITE_CONFIG, isPlaceholder } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { DISCLOSURE, NOT_YET, PROTECTIONS } from "@/lib/content/security";
import { pageMetadata } from "@/lib/seo";
import { Container } from "@/ui/layout/Container";
import { ReplaceBeforeLaunch } from "@/ui/layout/DocumentShell";
import { Guilloche, GuillocheBand } from "@/ui/engraving/Guilloche";
import { Microtext } from "@/ui/engraving/Microtext";
import { FeatureLedger } from "@/ui/security/FeatureLedger";
import { ButtonLink } from "@/ui/primitives/Button";
import { Legend } from "@/ui/primitives/Legend";

export const metadata: Metadata = pageMetadata({
  title: "Security",
  description:
    "How a MyPravaah reputation receipt resists forgery, how your financial data is protected in transit and at rest, what we deliberately do not do, and what we have not yet earned the right to claim.",
  path: ROUTES.SECURITY,
});

/**
 * Security.
 *
 * Drenched in the field colour throughout — this is the page where the visual
 * world and the argument are the same thing, and it should feel like the
 * reverse of a note rather than a policy page.
 *
 * PRODUCT.md forbids certification claims, so the page states its absences
 * explicitly instead of leaving a confident silence.
 */
export default function SecurityPage(): ReactElement {
  const { securityEmail } = SITE_CONFIG.legal;

  return (
    <>
      {/* Padding is top-only: the microtext and engine-turned band close the
          masthead at its bottom edge, the way a note's border meets the trim.
          Bottom padding here would leave them floating mid-field. */}
      <section className="relative overflow-clip bg-intaglio-deep pt-16 text-reverse sm:pt-24">
        <Guilloche
          seed={1}
          bands={7}
          className="absolute -left-48 top-1/2 h-[38rem] w-[38rem] -translate-y-1/2 text-latent-line/18 sm:-left-32"
        />

        <Container className="relative">
          <Legend className="text-latent">Security</Legend>

          <h1 className="denomination mt-8 max-w-4xl text-[2.5rem] text-reverse sm:text-6xl lg:text-[4.25rem]">
            Built to be checked by strangers and forged by nobody.
          </h1>

          <p className="mt-8 max-w-2xl text-base leading-relaxed text-reverse-dim sm:text-lg">
            Two things have to be true for this product to be worth anything: a
            lender that has never met you must be able to verify your receipt,
            and nobody must be able to manufacture one. Everything below serves
            one of those two.
          </p>
        </Container>

        <Microtext
          text="VERIFIABLE BY ANY PARTY · FORGEABLE BY NONE · HELD BY THE HOLDER"
          repeat={20}
          className="mt-16 px-5 pb-1 text-latent-line/50 sm:px-8 lg:px-12"
        />
        <GuillocheBand className="text-latent-line/35" height={16} />
      </section>

      {/* The ledger — printed feature against real mechanism. */}
      <section className="bg-intaglio py-20 sm:py-28">
        <Container>
          <FeatureLedger />
        </Container>
      </section>

      {/* Concrete protections, on rag: this is the part people read closely. */}
      <section className="border-b border-intaglio/12 bg-rag py-20 sm:py-28">
        <Container>
          <div className="max-w-3xl">
            <Legend className="text-intaglio-mid" rule>
              What actually protects you
            </Legend>
            <h2 className="denomination mt-8 text-[2rem] text-intaglio-deep sm:text-[2.75rem]">
              Architecture, not assurances.
            </h2>
            <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
              A promise can be broken quietly. These are properties of how the
              system is built, which means breaking one would require changing
              the system rather than changing its mind.
            </p>
          </div>

          <dl className="mt-16 grid gap-x-16 gap-y-12 lg:grid-cols-2">
            {PROTECTIONS.map((item) => (
              <div key={item.title}>
                <dt className="denomination text-xl text-intaglio-deep sm:text-2xl">
                  {item.title}
                </dt>
                <dd className="mt-4 max-w-xl text-[0.9375rem] leading-relaxed text-ink sm:text-base">
                  {item.body}
                </dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      {/* What we do not have. Stating absences is the point, not a caveat. */}
      <section className="border-b border-intaglio/12 bg-rag-shade/50 py-20 sm:py-28">
        <Container>
          <div className="max-w-3xl">
            <Legend className="text-carmine" rule>
              What we do not claim
            </Legend>
            <h2 className="denomination mt-8 text-[2rem] text-intaglio-deep sm:text-[2.75rem]">
              The gaps, stated plainly.
            </h2>
            <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
              A security page that lists only strengths is a marketing page. If
              you are deciding whether to trust us with financial data, these
              are the facts that should weigh against us. They are gaps rather
              than refusals — the things{" "}
              <Link
                href={ROUTES.WHAT_IS_BUILT}
                className="text-carmine underline decoration-carmine/40 underline-offset-4 transition-colors duration-200 hover:decoration-carmine"
              >
                this product is built never to do
              </Link>{" "}
              are a separate list, and a permanent one.
            </p>
          </div>

          <dl className="mt-14 grid gap-x-14 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {NOT_YET.map((item) => (
              <div key={item.title}>
                <dt className="denomination text-lg text-carmine-deep sm:text-xl">
                  {item.title}
                </dt>
                <dd className="mt-3 text-sm leading-relaxed text-ink">
                  {item.body}
                </dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      {/* Coordinated disclosure. */}
      <section className="bg-intaglio py-20 text-reverse sm:py-28">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-20">
            <div className="min-w-0">
              <Legend className="text-latent" rule>
                Reporting a vulnerability
              </Legend>
              <h2 className="denomination mt-8 max-w-xl text-[2rem] text-reverse sm:text-[2.75rem]">
                {DISCLOSURE.summary}
              </h2>

              <ul className="mt-10 flex flex-col gap-5">
                {DISCLOSURE.commitments.map((item) => (
                  <li
                    key={item}
                    className="flex gap-4 text-[0.9375rem] leading-relaxed text-reverse-dim sm:text-base"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[0.72em] h-px w-4 shrink-0 bg-latent"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <aside className="min-w-0">
              <div className="border border-latent-line/35 p-7 sm:p-8 notch-lg">
                <Legend className="text-latent">Where to send it</Legend>

                {isPlaceholder(securityEmail) ? (
                  <div className="mt-5">
                    <ReplaceBeforeLaunch tone="field">
                      No security contact address is published yet. Set{" "}
                      <code className="field-value">
                        SITE_CONFIG.legal.securityEmail
                      </code>{" "}
                      in <code className="field-value">lib/config/site.ts</code>{" "}
                      and this panel becomes a working address.
                    </ReplaceBeforeLaunch>
                  </div>
                ) : (
                  <a
                    href={`mailto:${securityEmail}`}
                    className="field-value mt-5 block break-words text-sm text-reverse underline decoration-latent/50 underline-offset-4 transition-colors hover:text-latent"
                  >
                    {securityEmail}
                  </a>
                )}

                <p className="mt-6 text-sm leading-relaxed text-reverse-dim">
                  Include what you found, how to reproduce it, and what you
                  think the impact is. You do not need to prove exploitability
                  to be taken seriously.
                </p>
              </div>

              <ButtonLink
                href={ROUTES.LEGAL.PRIVACY}
                variant="quiet"
                className="mt-6 w-full"
              >
                How we handle your data
              </ButtonLink>
            </aside>
          </div>
        </Container>
      </section>
    </>
  );
}
