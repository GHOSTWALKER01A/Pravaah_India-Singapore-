import type { ReactElement } from "react";

import { DOCUMENTS, ROUTES } from "@/lib/constants/routes";
import { Container } from "@/ui/layout/Container";
import { Guilloche } from "@/ui/engraving/Guilloche";
import { Footer } from "@/ui/layout/Footer";
import { Header } from "@/ui/layout/Header";
import { ButtonLink } from "@/ui/primitives/Button";
import { Legend } from "@/ui/primitives/Legend";
import Link from "next/link";

/**
 * Not found. Mounts the chrome itself — a root-level not-found sits outside
 * every route group, so it does not inherit SiteLayout.
 */
export default function NotFound(): ReactElement {
  return (
    <>
      <Header />
      <main
        id="main"
        className="relative flex-auto overflow-hidden bg-intaglio py-24 text-reverse sm:py-32"
      >
        <Guilloche
          seed={3}
          bands={5}
          className="absolute -right-32 top-1/2 h-[32rem] w-[32rem] -translate-y-1/2 text-latent-line/18"
        />

        <Container className="relative">
          <div className="max-w-xl">
            <Legend className="text-latent">Not in circulation</Legend>

            <p className="denomination mt-7 text-7xl text-latent sm:text-8xl">
              404
            </p>

            <h1 className="denomination mt-6 text-3xl text-reverse sm:text-4xl">
              There is no page at this address.
            </h1>

            <p className="mt-6 text-base leading-relaxed text-reverse-dim">
              It may have moved, or the link may be wrong. Everything this site
              publishes is one of the pages below.
            </p>

            <ul className="mt-10 flex flex-col gap-4">
              {[
                {
                  label: "Introduction",
                  href: ROUTES.HOME,
                  blurb: "What Pravaah is and how the data moves.",
                },
                {
                  label: "How to apply",
                  href: ROUTES.HOW_TO_APPLY,
                  blurb: "Every step, in the order it happens.",
                },
                ...DOCUMENTS,
              ].map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="group flex flex-col">
                    <span className="denomination text-xl text-reverse transition-colors duration-200 group-hover:text-latent">
                      {item.label}
                    </span>
                    <span className="mt-1 text-sm leading-relaxed text-reverse-dim">
                      {item.blurb}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <ButtonLink href={ROUTES.HOME} variant="reverse" className="mt-12">
              Back to the start
            </ButtonLink>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
