import type { Metadata } from "next";
import type { ReactElement } from "react";

import { buildOpenAppHref } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { CHECKS, REQUIRED_CHECKS } from "@/lib/content/corridor-checks";
import { pageMetadata } from "@/lib/seo";
import { howToApplyJsonLd } from "@/lib/seo/json-ld";
import { CorridorSteps } from "@/ui/apply/CorridorSteps";
import { Outcomes } from "@/ui/apply/Outcomes";
import { Container } from "@/ui/layout/Container";
import { Guilloche, GuillocheBand } from "@/ui/engraving/Guilloche";
import { ButtonLink } from "@/ui/primitives/Button";
import { DataField, DataFieldGrid } from "@/ui/primitives/DataField";
import { Legend } from "@/ui/primitives/Legend";

export const metadata: Metadata = pageMetadata({
  title: "How to apply",
  description:
    "The identity checks required to hold a Pravaah reputation passport, in the order they are enforced — what each one asks of you, what it proves, and what you need in hand.",
  path: ROUTES.HOW_TO_APPLY,
});

/**
 * Steps to apply.
 *
 * The reader's question is "what will this actually cost me in time and
 * documents", so the page answers that before it argues anything. The
 * corridor selector is client-side; everything else renders on the server.
 */
export default function HowToApplyPage(): ReactElement {
  // Structured data uses the India sequence — the longest single-country path
  // and the one most searches will be for.
  const jsonLd = howToApplyJsonLd(
    REQUIRED_CHECKS.INDIA.map((id) => ({
      label: CHECKS[id].label,
      action: CHECKS[id].action,
    })),
  );

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Masthead on the field colour, so the page opens as part of the note
          rather than as a document. */}
      {/* Top-only padding: the engine-turned band closes the masthead at the
          trim edge. Bottom padding would leave it floating mid-field. */}
      <section className="relative overflow-hidden bg-intaglio pt-16 text-reverse sm:pt-24">
        <Guilloche
          seed={0}
          bands={6}
          className="absolute -right-40 top-1/2 h-[36rem] w-[36rem] -translate-y-1/2 text-latent-line/20 sm:-right-24"
        />

        <Container className="relative">
          <Legend className="text-latent">Applying · what it involves</Legend>

          <h1 className="denomination mt-8 max-w-4xl text-[2.5rem] text-reverse sm:text-6xl lg:text-[4.25rem]">
            Prove who you are once. Then decide what to share.
          </h1>

          <p className="mt-8 max-w-2xl text-base leading-relaxed text-reverse-dim sm:text-lg">
            Identity comes first and everything else waits on it. Nothing about
            your financial history is requested until you are verified, and
            nothing is collected until you separately consent to it. Here is
            every step, in the order it happens.
          </p>

          <div className="mt-12 border-t border-reverse/20 pt-9">
            <DataFieldGrid className="grid-cols-2 sm:grid-cols-4">
              <DataField label="Steps" value="4 – 7, by corridor" />
              <DataField label="Typical time" value="Under 15 minutes" />
              <DataField label="Cost to you" value="Nothing" />
              <DataField label="Repeat later" value="Not required" />
            </DataFieldGrid>
          </div>
        </Container>

        <GuillocheBand className="mt-14 text-latent-line/35" height={16} />
      </section>

      {/* Before you start. */}
      <section className="border-b border-intaglio/12 bg-rag py-18 sm:py-24">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16">
            <div>
              <Legend as="h2" className="text-intaglio-mid" rule>
                Before you start
              </Legend>
            </div>

            <div className="max-w-2xl">
              <p className="text-base leading-relaxed text-ink sm:text-lg">
                You do not need documents scanned, notarised or attested.
                Everything is pulled from the authority that issued it or
                confirmed by the institution that holds it — which is why this
                takes minutes rather than weeks.
              </p>

              <ul className="mt-9 flex flex-col gap-5">
                {[
                  "A phone with a working front camera and reasonable light.",
                  "Your PAN number, and an Aadhaar-linked mobile number for the DigiLocker step (India).",
                  "Your bank account number and IFSC (India).",
                  "A Singpass account (Singapore).",
                ].map((item) => (
                  <li
                    key={item}
                    className="flex gap-4 text-[0.9375rem] leading-relaxed text-ink"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[0.72em] h-px w-4 shrink-0 bg-carmine"
                    />
                    {item}
                  </li>
                ))}
              </ul>

              <p className="mt-9 text-[0.9375rem] leading-relaxed text-intaglio">
                You will never be asked for a bank password, a net-banking PIN,
                or a one-time password read out to a person. Nobody from Pravaah
                will ever ask you for those.
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* The sequence. */}
      <section className="border-b border-intaglio/12 bg-rag py-18 sm:py-24">
        <Container>
          <div className="max-w-3xl">
            <Legend className="text-intaglio-mid" rule>
              The sequence
            </Legend>
            <h2 className="denomination mt-8 text-[2rem] text-intaglio-deep sm:text-[2.75rem]">
              The steps differ by corridor, because the documents do.
            </h2>
          </div>

          <div className="mt-14">
            <CorridorSteps />
          </div>
        </Container>
      </section>

      {/* Outcomes. */}
      <section className="border-b border-intaglio/12 bg-rag-shade/40 py-18 sm:py-24">
        <Container>
          <Outcomes />
        </Container>
      </section>

      {/* After verification — the consent step, which is separate on purpose. */}
      <section className="bg-intaglio py-20 text-reverse sm:py-28">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-20">
            <div className="max-w-2xl">
              <Legend className="text-latent" rule>
                Then, separately
              </Legend>
              <h2 className="denomination mt-8 text-[2rem] text-reverse sm:text-[2.75rem]">
                Being verified is not the same as sharing anything.
              </h2>
              <p className="mt-7 text-base leading-relaxed text-reverse-dim sm:text-lg">
                Verification proves you are you. It grants us nothing. Your
                financial history moves only after you separately approve a
                consent request — on the Account Aggregator&rsquo;s screen, for a
                named purpose, over a named period, with a retention window you
                can see before you agree to it.
              </p>
              <p className="mt-5 text-base leading-relaxed text-reverse-dim sm:text-lg">
                You can revoke that consent at any time, and the data is deleted
                immediately.
              </p>

              <div className="mt-11 flex flex-col gap-3 sm:flex-row sm:items-center">
                <ButtonLink href={`${ROUTES.HOME}#how-it-works`} variant="reverse">
                  How the data moves
                </ButtonLink>
                <ButtonLink href={ROUTES.LEGAL.RULES} variant="quiet">
                  Read the rules
                </ButtonLink>
              </div>
            </div>

            <aside className="border border-latent-line/35 p-7 sm:p-8 notch-lg">
              <Legend className="text-latent">Not released yet</Legend>
              <p className="mt-5 text-[0.9375rem] leading-relaxed text-reverse-dim">
                Pravaah is not on the App Store or Google Play. Nothing on this
                page can be completed today — it describes the flow that is
                built and working, so you know exactly what to expect when the
                app is released.
              </p>
              <ButtonLink
                href={buildOpenAppHref({ source: "how-to-apply" })}
                variant="quiet"
                className="mt-7 w-full"
              >
                App availability
              </ButtonLink>
            </aside>
          </div>
        </Container>
      </section>
    </>
  );
}
