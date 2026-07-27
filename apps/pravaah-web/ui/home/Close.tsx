import type { ReactElement } from "react";

import { buildOpenAppHref } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { Container } from "@/ui/layout/Container";
import { Guilloche } from "@/ui/engraving/Guilloche";
import { ButtonLink } from "@/ui/primitives/Button";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The close. A real anchor rather than a repeated claim: the one sentence the
 * whole product answers to, set at denomination scale, and the two things a
 * reader can actually do next.
 */
export function Close(): ReactElement {
  return (
    <section className="relative overflow-hidden bg-intaglio-deep py-24 text-reverse sm:py-32">
      <Guilloche
        seed={3}
        bands={6}
        className="absolute left-1/2 top-1/2 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 text-latent-line/12 sm:h-[52rem] sm:w-[52rem]"
      />

      <Container className="relative">
        <div className="max-w-4xl">
          <Legend className="text-latent">The whole thing, in one sentence</Legend>

          <p className="denomination mt-9 text-[2rem] leading-[1.1] text-reverse sm:text-[2.875rem] lg:text-[3.5rem]">
            We are not building a payments app. We are building the thing that
            lets a person&rsquo;s financial reputation cross a border with them
            &mdash;{" "}
            <span className="text-latent">
              consented, explainable, and owned by the user.
            </span>
          </p>

          <div className="mt-14 flex flex-col gap-3 sm:flex-row sm:items-center">
            <ButtonLink href={ROUTES.HOW_TO_APPLY} variant="reverse">
              See what applying involves
            </ButtonLink>
            <ButtonLink
              href={buildOpenAppHref({ source: "close" })}
              variant="quiet"
            >
              Get the app
            </ButtonLink>
          </div>

          <p className="mt-6 max-w-md text-sm leading-relaxed text-reverse-dim">
            The app is not released yet. Identity verification and consented
            data collection work end to end today; the score and the issued
            passport are still being built.
          </p>
        </div>
      </Container>
    </section>
  );
}
