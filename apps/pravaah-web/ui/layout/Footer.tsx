import Link from "next/link";
import type { ReactElement } from "react";

import {
  APP_IS_PUBLISHED,
  MARKET,
  SITE_CONFIG,
  STAGE,
  buildOpenAppHref,
} from "@/lib/config/site";
import { DOCUMENTS, NAV_ITEMS, ROUTES } from "@/lib/constants/routes";
import { GuillocheBand } from "@/ui/engraving/Guilloche";
import { Microtext } from "@/ui/engraving/Microtext";
import { Seal } from "@/ui/engraving/Seal";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The footer is the note's reverse: the issuing legend, the obligations, and
 * the serial. It is drenched in the field colour because a note's reverse is
 * a full-bleed printed face, not a pale strip of small links.
 */
export function Footer(): ReactElement {
  const year = new Date().getFullYear();

  return (
    <footer className="relative mt-px bg-intaglio text-reverse">
      <GuillocheBand className="text-latent-line/40" height={16} />

      <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-20 lg:px-12">
        <div className="grid gap-12 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            {/* The reverse of a note carries the issuing mark at size. This is
                the one surface with room for the standard cut, so it gets it —
                the header's 26px seal is the small cut, and the two are the
                same figure at two optical sizes rather than two logos. */}
            <div className="flex items-center gap-4">
              <Seal size={48} className="text-latent-line" />
              <p className="denomination text-4xl text-reverse sm:text-5xl">
                MyPravaah
              </p>
            </div>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-reverse-dim">
              {SITE_CONFIG.tagline} Built for {MARKET.name}.
            </p>

            <Link
              href={buildOpenAppHref({ source: "footer" })}
              className="legend mt-8 inline-flex items-center gap-2 border border-latent-line/55 px-5 py-3 text-latent transition-colors duration-200 hover:bg-latent hover:text-intaglio-deep"
            >
              {APP_IS_PUBLISHED ? "Get the app" : "App — not yet released"}
              <span aria-hidden="true">→</span>
            </Link>
          </div>

          <nav aria-labelledby="footer-nav-site">
            <Legend id="footer-nav-site" as="h2" className="text-reverse-dim">
              This site
            </Legend>
            <ul className="mt-5 flex flex-col gap-3.5">
              {NAV_ITEMS.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-reverse transition-colors duration-200 hover:text-latent"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href={ROUTES.GET_APP}
                  className="text-sm text-reverse transition-colors duration-200 hover:text-latent"
                >
                  Get the app
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-labelledby="footer-nav-docs">
            <Legend id="footer-nav-docs" as="h2" className="text-reverse-dim">
              Documents
            </Legend>
            <ul className="mt-5 flex flex-col gap-3.5">
              {DOCUMENTS.map((doc) => (
                <li key={doc.href}>
                  <Link
                    href={doc.href}
                    className="text-sm text-reverse transition-colors duration-200 hover:text-latent"
                  >
                    {doc.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* The obligation line a note carries across its face. Ours states the
            one thing this audience most needs to be able to rely on. */}
        <div className="mt-16 border-t border-reverse/15 pt-8">
          <p className="max-w-2xl text-sm leading-relaxed text-reverse-dim">
            <span className="text-reverse">
              We will never ask you for your bank password.
            </span>{" "}
            Financial data reaches us only through India&rsquo;s regulated
            Account Aggregator rail, only with consent you grant on the
            aggregator&rsquo;s own screen, and only for the purpose and period
            you approved.
          </p>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <p className="field-value text-xs text-reverse-dim">
              © {year} MyPravaah · {SITE_CONFIG.legal.entityName}
            </p>
            {/* Read from STAGE rather than restated: this line said "identity
                and consent in service · scoring and passport in development"
                for as long as it took the other six modules to be finished,
                which is exactly the drift a hardcoded stage produces. */}
            <p className="legend text-reverse-dim">{STAGE.short}</p>
          </div>
        </div>
      </div>

      <Microtext
        text="MYPRAVAAH · CONSENTED · EXPLAINABLE · OWNED BY THE HOLDER"
        repeat={40}
        className="border-t border-reverse/10 px-5 py-1.5 text-latent-line/60 sm:px-8 lg:px-12"
      />
    </footer>
  );
}
