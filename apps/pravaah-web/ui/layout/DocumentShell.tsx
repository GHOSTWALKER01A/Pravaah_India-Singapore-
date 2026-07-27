import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import { SITE_CONFIG } from "@/lib/config/site";
import { DOCUMENTS } from "@/lib/constants/routes";
import { cn } from "@/lib/utils";
import { Container } from "@/ui/layout/Container";
import { GuillocheBand } from "@/ui/engraving/Guilloche";
import { Legend } from "@/ui/primitives/Legend";

/**
 * Chrome for the long-form documents — privacy, rules, terms.
 *
 * These stay on the rag substrate rather than the field colour, because a
 * document is a light object and because this is the one place on the site
 * where someone reads several thousand words in a row. The reading column is
 * held at measure; the heading region gets the note's masthead treatment.
 */
export function DocumentShell({
  title,
  standfirst,
  updated = SITE_CONFIG.legal.lastUpdated,
  reference,
  children,
}: {
  title: string;
  /** One paragraph telling the reader whether this is the page they need. */
  standfirst: string;
  updated?: string;
  /** Document reference, set like a note's series designation. */
  reference: string;
  children: ReactNode;
}): ReactElement {
  return (
    <article>
      {/* The masthead is a distinct plate, at full shade rather than a tint —
          at 45% it was indistinguishable from the sheet and the document read
          as one undifferentiated field. */}
      <header className="border-b border-intaglio/20 bg-rag-shade py-14 sm:py-20">
        <Container>
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
            <Legend className="text-intaglio-mid">
              Pravaah · {reference}
            </Legend>
            <Legend className="text-intaglio-mid">
              Last updated {updated}
            </Legend>
          </div>

          <h1 className="denomination mt-7 max-w-3xl text-[2.75rem] text-intaglio-deep sm:text-6xl lg:text-7xl">
            {title}
          </h1>

          <p className="mt-7 max-w-2xl text-base leading-relaxed text-intaglio sm:text-lg">
            {standfirst}
          </p>
        </Container>
      </header>

      <Container>
        <div className="sheet-prose max-w-[68ch] py-14 text-ink sm:py-20">
          {children}
        </div>
      </Container>

      {/* Cross-links, so a reader who opened the wrong document finds the
          right one without going back to the nav. */}
      <div className="border-t border-intaglio/20 bg-rag-shade">
        <GuillocheBand className="text-intaglio/25" height={12} />
        <Container>
          <div className="py-14 sm:py-16">
            <Legend as="h2" className="text-intaglio-mid" rule>
              The other documents
            </Legend>
            <ul className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2">
              {DOCUMENTS.filter((doc) => doc.label !== title).map((doc) => (
                <li key={doc.href}>
                  <Link href={doc.href} className="group block">
                    <span className="denomination text-2xl text-intaglio-deep underline decoration-carmine/0 decoration-1 underline-offset-[6px] transition-colors duration-200 group-hover:decoration-carmine">
                      {doc.label}
                    </span>
                    <span className="mt-1.5 block max-w-sm text-sm leading-relaxed text-intaglio-mid">
                      {doc.blurb}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </div>
    </article>
  );
}

/**
 * A visibly marked gap in the document. PRODUCT.md forbids inventing an entity
 * name, an address or a grievance contact, and a legal page that quietly omits
 * them reads as complete when it is not — so the gap is stated, in the second
 * colour, where neither the reader nor the person shipping this can miss it.
 */
export function ReplaceBeforeLaunch({
  children,
  tone = "rag",
}: {
  children: ReactNode;
  /** `field` for use inside a drenched intaglio region. */
  tone?: "rag" | "field";
}): ReactElement {
  return (
    <p
      className={cn(
        "border px-5 py-4 text-[0.9375rem] leading-relaxed",
        tone === "rag"
          ? "border-carmine/35 bg-carmine/5 text-carmine-deep"
          : "border-latent-line/45 bg-latent/10 text-reverse",
      )}
    >
      <span
        className={cn(
          "legend mb-1.5 block",
          tone === "rag" ? "text-carmine" : "text-latent",
        )}
      >
        Replace before launch
      </span>
      {children}
    </p>
  );
}
