import type { Metadata } from "next";
import type { ReactElement } from "react";

import { STAGE } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { BUILD_FACTS, REFUSALS, SURFACES } from "@/lib/content/modules";
import { pageMetadata } from "@/lib/seo";
import { Decisions } from "@/ui/built/Decisions";
import { EvidenceList } from "@/ui/built/EvidenceList";
import { ModuleLedger } from "@/ui/built/ModuleLedger";
import { Guilloche, GuillocheBand } from "@/ui/engraving/Guilloche";
import { Microtext } from "@/ui/engraving/Microtext";
import { Container } from "@/ui/layout/Container";
import { ButtonLink } from "@/ui/primitives/Button";
import { DataField, DataFieldGrid } from "@/ui/primitives/DataField";
import { Legend } from "@/ui/primitives/Legend";

export const metadata: Metadata = pageMetadata({
  title: "What is built",
  description:
    "The eight built MyPravaah modules in full — identity, consent, scoring, the reputation receipt, panel verification, payments, insurance and the fraud engine — plus the AI copilot and the two layers being built around it, what is still outstanding, and the commands that prove it.",
  path: ROUTES.WHAT_IS_BUILT,
});

/**
 * The build record.
 *
 * Two audiences, one set of facts. A holder reads it to find out what the
 * product will actually do for them; somebody assessing the work reads it to
 * find out whether any of it is real. Writing two pages would mean maintaining
 * two truths, and the second one would rot — so this page states the facts once
 * and varies only the depth, running shallow (what it is, what you get) to deep
 * (the decisions, the runnable checks).
 *
 * It opens with the limitation rather than the achievement. A page that says
 * "eight modules complete" and defers the licensing position — or the fact that
 * the copilot is not built — to a footer has chosen to be misread, and this is
 * the audience least able to afford that.
 */
export default function WhatIsBuiltPage(): ReactElement {
  return (
    <>
      {/* Masthead. Top padding only — the microtext and band close it at the
          trim edge, as on the other field-colour mastheads. */}
      <section className="relative overflow-clip bg-intaglio-deep pt-16 text-reverse sm:pt-24">
        <Guilloche
          seed={3}
          bands={7}
          className="absolute -right-44 top-1/2 h-[38rem] w-[38rem] -translate-y-1/2 text-latent-line/18 sm:-right-28"
        />

        <Container className="relative">
          <Legend className="text-latent">The build · stated in full</Legend>

          <h1 className="denomination mt-8 max-w-4xl text-[2.5rem] text-reverse sm:text-6xl lg:text-[4.25rem]">
            Eight modules finished. One in build. Nothing you can use today.
          </h1>

          <p className="mt-8 max-w-2xl text-base leading-relaxed text-reverse-dim sm:text-lg">
            All three parts of that sentence are true and none cancels another.
            The engine is complete and exercised end to end against a real
            database. The AI copilot that will run it as one conversation is
            being built, and is described here in the future tense. And none of
            it is a licensed financial service, so it moves no real money and
            issues no policy that is in force. This page separates those facts
            rather than averaging them into something more flattering.
          </p>

          {/* The data-field grid a note prints along its base — with each
              figure's derivation set beneath it. The caption is not decoration:
              a number a reader cannot re-derive is a number they are being
              asked to trust, which is the thing this page is arguing against. */}
          <div className="mt-12 border-t border-reverse/20 pt-9">
            <DataFieldGrid className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              {BUILD_FACTS.map((fact) => (
                <DataField
                  key={fact.label}
                  label={fact.label}
                  value={
                    <>
                      {fact.value}
                      <span className="mt-2 block font-sans text-xs leading-relaxed tracking-normal text-reverse-dim">
                        {fact.from}
                      </span>
                    </>
                  }
                />
              ))}
            </DataFieldGrid>
          </div>
        </Container>

        <Microtext
          text="EIGHT MODULES BUILT · COPILOT IN BUILD · NO LICENCE HELD · NO REAL MONEY MOVED · NO POLICY IN FORCE"
          repeat={14}
          className="mt-16 px-5 pb-1 text-latent-line/50 sm:px-8 lg:px-12"
        />
        <GuillocheBand className="text-latent-line/35" height={16} />
      </section>

      {/* Where it actually stands — the two facts, side by side, before any
          detail. The carmine panel is the second colour doing its job. */}
      <section className="border-b border-intaglio/12 bg-rag py-18 sm:py-24">
        <Container>
          <div className="grid gap-px border border-intaglio/20 bg-intaglio/20 lg:grid-cols-2">
            <div className="bg-rag p-7 sm:p-10">
              <Legend className="text-intaglio-mid">What is finished</Legend>
              <p className="mt-6 text-base leading-relaxed text-ink sm:text-lg">
                {STAGE.built}
              </p>
            </div>

            <div className="bg-rag-shade/60 p-7 sm:p-10">
              <Legend className="text-carmine">What is not real</Legend>
              <p className="mt-6 text-base leading-relaxed text-ink sm:text-lg">
                {STAGE.pending}
              </p>
              <p className="mt-5 text-[0.9375rem] leading-relaxed text-ink">
                {STAGE.building}
              </p>
              <p className="mt-5 text-[0.9375rem] leading-relaxed text-carmine-deep">
                {STAGE.release}
              </p>
            </div>
          </div>
        </Container>
      </section>

      {/* The eight modules at depth, on the field colour. */}
      <section className="bg-intaglio py-20 sm:py-28">
        <Container>
          <ModuleLedger />
        </Container>
      </section>

      {/* The three surfaces. */}
      <section className="border-b border-intaglio/12 bg-rag py-20 sm:py-28">
        <Container>
          <div className="max-w-3xl">
            <Legend className="text-intaglio-mid" rule>
              Where it runs
            </Legend>
            <h2 className="denomination mt-8 text-[2rem] text-intaglio-deep sm:text-[2.75rem]">
              Three surfaces, because a person, a service and a reviewer need
              different things.
            </h2>
            <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
              The staff console is not an afterthought here. The product refuses
              to auto-reject a near-miss name, refuses to decline a payment it is
              merely unsure about, and refuses to settle a claim without a
              person — and every one of those refusals is a queue somebody has to
              work. Building the app without the console would have made those
              promises decorative.
            </p>
          </div>

          <dl className="mt-16 grid gap-x-14 gap-y-14 lg:grid-cols-3">
            {SURFACES.map((surface) => (
              <div key={surface.name} className="min-w-0">
                <dt>
                  <span className="denomination block text-2xl text-intaglio-deep sm:text-[1.75rem]">
                    {surface.name}
                  </span>
                  <span className="legend mt-2.5 block text-carmine">
                    {surface.role}
                  </span>
                </dt>
                <dd>
                  <p className="mt-5 text-[0.9375rem] leading-relaxed text-ink">
                    {surface.detail}
                  </p>
                  <ul className="mt-6 flex flex-col gap-2.5 border-t border-intaglio/20 pt-6">
                    {surface.holds.map((item) => (
                      <li
                        key={item}
                        className="flex gap-3 text-sm leading-relaxed text-intaglio"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-[0.7em] h-px w-3 shrink-0 bg-intaglio-mid"
                        />
                        {item}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      {/* The decisions. */}
      <section className="border-b border-intaglio/12 bg-rag-shade/40 py-20 sm:py-28">
        <Container>
          <Decisions />
        </Container>
      </section>

      {/* The evidence, on the field colour: this is the section that answers
          the sceptic, and it should feel like the reverse of the note. */}
      <section className="bg-intaglio py-20 text-reverse sm:py-28">
        <Container>
          <EvidenceList />
        </Container>
      </section>

      {/* Refusals — permanent, as distinct from the gaps on /security. */}
      <section className="border-b border-intaglio/12 bg-rag py-20 sm:py-28">
        <Container>
          <div className="max-w-3xl">
            <Legend className="text-carmine" rule>
              What this will not do
            </Legend>
            <h2 className="denomination mt-8 text-[2rem] text-intaglio-deep sm:text-[2.75rem]">
              Not gaps. Commitments.
            </h2>
            <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
              The security page lists what we have not earned yet. These are
              different: they are things the product is built not to do, and
              stating them is the only way you can hold us to them later.
            </p>
          </div>

          <dl className="mt-14 grid gap-x-16 gap-y-11 lg:grid-cols-2">
            {REFUSALS.map((item) => (
              <div key={item.title}>
                <dt className="denomination text-xl text-carmine-deep sm:text-2xl">
                  {item.title}
                </dt>
                <dd className="mt-3.5 max-w-xl text-[0.9375rem] leading-relaxed text-ink">
                  {item.body}
                </dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      {/* Close. */}
      <section className="bg-intaglio-deep py-20 text-reverse sm:py-28">
        <Container>
          <div className="max-w-3xl">
            <Legend className="text-latent" rule>
              Next
            </Legend>
            <p className="denomination mt-8 text-[1.75rem] leading-[1.15] text-reverse sm:text-[2.5rem]">
              The interesting question was never whether the features exist. It
              was whether a lender can check your receipt without calling us,
              whether a refusal arrives with its reason, and whether you can take
              your data back.{" "}
              <span className="text-latent">All three are answered.</span>
            </p>

            <div className="mt-12 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink href={ROUTES.SECURITY} variant="reverse">
                How it resists forgery
              </ButtonLink>
              <ButtonLink href={ROUTES.HOW_TO_APPLY} variant="quiet">
                What applying involves
              </ButtonLink>
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}
