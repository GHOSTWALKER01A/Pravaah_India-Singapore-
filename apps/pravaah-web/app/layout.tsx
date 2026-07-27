import type { Metadata, Viewport } from "next";
import { Archivo, Azeret_Mono, Bodoni_Moda } from "next/font/google";
import type { ReactElement, ReactNode } from "react";

import "@/lib/styles/globals.css";
import { ROOT_METADATA } from "@/lib/seo";
import { organisationJsonLd, websiteJsonLd } from "@/lib/seo/json-ld";
import { cn } from "@/lib/utils";
import { SmoothScroll } from "@/ui/motion/SmoothScroll";

/*
  ── DIRECTION CONTRACT ──────────────────────────────────────────────────────
  THESIS: A banknote is state-issued trust made portable and carried by the
  bearer — exactly Pravaah's mechanism. This site is the face of that note. It
  refuses the navy-gradient fintech landing page with a floating phone mockup,
  and equally refuses the stark white Swiss grid.
  OWN-WORLD: Cool security-rag substrate (#EEEFE7, never cream) against drenched
  intaglio green (#0E3B2E) owning whole regions; carmine as the second-colour
  iris print for the word under pressure; latent gold for thread and seals.
  Bodoni Moda denominations, Archivo widened to engraver's gothic legends,
  Azeret Mono for serials and data fields. Containers are engraved panels with
  cut corners, generated guilloche and real microtext — never cards.
  STORY: Your history died at the airport. It does not have to. A consented,
  explainable credential that you hold travels with you — here is what applying
  actually takes.
  FIRST VIEWPORT: Full-bleed intaglio field. Issuing legend and hairline top
  left; a guilloche rosette holding the IN↔SG latent panel at the right; the
  didone promise at note-legend scale across the left two-thirds; the data-field
  grid and both actions along the base, primary first.
  FORM: Security engraving / banknote intaglio — candidate 4 of the ordered
  grounded list, assigned by concept-seed key cba9eee6, staged as the
  diffuse-to-stream capture column.
  ────────────────────────────────────────────────────────────────────────────
*/

/** The engraved denomination face: a true didone, high stroke contrast. */
const bodoni = Bodoni_Moda({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-bodoni",
  weight: ["400", "500", "600"],
});

/**
 * Text and legends. The `wdth` axis is what makes engraver's gothic possible —
 * widened to 118 and tracked out, this is a note's issuing-authority line.
 */
const archivo = Archivo({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-archivo",
  axes: ["wdth"],
});

/** Serials, identifiers, dates. Measurement, not costume. */
const azeret = Azeret_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-azeret",
  weight: ["400", "500"],
});

export const metadata: Metadata = ROOT_METADATA;

export const viewport: Viewport = {
  // The substrate colour, so the browser chrome joins the sheet instead of
  // flashing white against it.
  themeColor: "#eeefe7",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        bodoni.variable,
        archivo.variable,
        azeret.variable,
      )}
    >
      <body className="flex min-h-full flex-col">
        <script
          type="application/ld+json"
          // Serialised server-side from a literal object in lib/seo — no user
          // input reaches this string.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([organisationJsonLd(), websiteJsonLd()]),
          }}
        />
        <SmoothScroll />
        {children}
      </body>
    </html>
  );
}
