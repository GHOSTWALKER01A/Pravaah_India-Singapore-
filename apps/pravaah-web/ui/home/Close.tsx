import Link from "next/link";
import type { ReactElement } from "react";

import { STAGE, buildOpenAppHref } from "@/lib/config/site";
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
    <section className="relative overflow-clip bg-intaglio-deep py-24 text-reverse sm:py-32">
      <Guilloche
        seed={3}
        bands={6}
        className="absolute left-1/2 top-1/2 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 text-latent-line/12 sm:h-[52rem] sm:w-[52rem]"
      />

      <Container className="relative">
        <div className="max-w-4xl">
          <Legend className="text-latent">The whole thing, in one sentence</Legend>

          <p className="denomination mt-9 text-[2rem] leading-[1.1] text-reverse sm:text-[2.875rem] lg:text-[3.5rem]">
            We don&rsquo;t lend and we don&rsquo;t underwrite. We make the road
            to a lender&rsquo;s decision honest &mdash;{" "}
            <span className="text-latent">
              proved once, with the proof kept by the person it belongs to.
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
              App availability
            </ButtonLink>
          </div>

          {/* The last thing on the page is the limitation, not the pitch. A
              close that repeats the claim it opened with has told the reader
              nothing; this one tells them the thing they would otherwise find
              out from somebody else. */}
          <p className="mt-8 max-w-xl text-sm leading-relaxed text-reverse-dim">
            {STAGE.headline}{" "}
            <Link
              href={ROUTES.WHAT_IS_BUILT}
              className="text-latent underline decoration-latent/40 underline-offset-4 transition-colors duration-200 hover:decoration-latent"
            >
              Everything that is built, and everything that is not, is set out
              in full.
            </Link>
          </p>
        </div>
      </Container>
    </section>
  );
}
