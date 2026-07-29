import type { ReactElement } from "react";

import { CORRIDOR } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { Guilloche, GuillocheBand } from "@/ui/engraving/Guilloche";
import { Microtext } from "@/ui/engraving/Microtext";
import { ButtonLink } from "@/ui/primitives/Button";
import { DataField, DataFieldGrid } from "@/ui/primitives/DataField";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The first viewport: the face of the note.
 *
 * Not a hero. The composition is the object — issuing legend at the top edge,
 * the denomination promise across the left, the guilloche rosette holding the
 * corridor's latent panel at the right, and the data-field grid along the base
 * where a note prints its series and serial.
 */
export function Face(): ReactElement {
  return (
    <section className="relative overflow-clip bg-intaglio text-reverse">
      {/* Watermark rosette bled off the right edge, as a note's portrait
          watermark sits in its own reserved field. */}
      {/* Watermark rosette. Held back on narrow screens, where the headline
          sits directly over it and the sheet has no margin to spare. */}
      <Guilloche
        seed={2}
        bands={7}
        className="absolute -right-32 -top-24 h-[34rem] w-[34rem] text-latent-line/14 sm:-right-24 sm:h-[42rem] sm:w-[42rem] sm:text-latent-line/25 lg:right-[-6rem] lg:h-[46rem] lg:w-[46rem]"
      />

      <div className="relative mx-auto w-full max-w-6xl px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-14 lg:px-12">
        {/* Issuing legend + hairline: the line a note runs along its top. The
            long legend wraps within its own column rather than pushing the
            corridor mark onto a second row. */}
        <div className="flex items-start justify-between gap-x-8 border-b border-reverse/20 pb-4">
          <Legend className="min-w-0 text-reverse-dim">
            Reputation passport · issued to the holder
          </Legend>
          <Legend className="shrink-0 text-latent">
            {CORRIDOR.from.code} ⟷ {CORRIDOR.to.code}
          </Legend>
        </div>

        <div className="grid gap-12 pt-14 sm:pt-20 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:gap-16">
          <div>
            <h1 className="denomination text-[2.875rem] text-reverse sm:text-[4.25rem] lg:text-[5.25rem]">
              Your financial reputation
              <span className="block text-latent">crosses the border</span>
              with you.
            </h1>

            <p className="mt-9 max-w-xl text-base leading-relaxed text-reverse-dim sm:text-lg">
              You spent years paying on time. You land somewhere new and the
              financial system there has never heard of you — no loan, a
              rejected tenancy, insurance priced for a stranger. MyPravaah turns
              the history you already built into a credential you hold and can
              present anywhere.
            </p>

            <div className="mt-11 flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink href={ROUTES.HOW_TO_APPLY} variant="reverse">
                What applying involves
              </ButtonLink>
              <ButtonLink href={ROUTES.WHAT_IS_BUILT} variant="quiet">
                What is built
              </ButtonLink>
            </div>

            {/* The stage, in the first viewport rather than a footer. This
                audience is deciding whether to trust a stranger with financial
                data; discovering the licensing position three pages in would be
                the thing that loses them, and putting it here costs nothing we
                are entitled to keep. */}
            <p className="legend mt-6 max-w-md text-reverse-dim">
              All eight modules built · not yet licensed · not yet on the App
              Store or Google Play
            </p>
          </div>

          {/* The latent panel: on a note, the denomination visible only at the
              right angle. It resolves as the section scrolls into view and is
              fully legible without the animation. */}
          <div className="relative lg:pt-6">
            <div className="relative border border-latent-line/35 bg-intaglio-deep/55 p-7 sm:p-9 notch-lg">
              {/* Faded downward so the lathe work stays behind the display
                  line and off the monospaced field values, which need a clean
                  ground to be read as data. */}
              <Guilloche
                seed={4}
                bands={4}
                className="absolute inset-0 h-full w-full text-latent-line/22 [mask-image:linear-gradient(to_bottom,black,transparent_58%)]"
              />

              <div className="relative">
                <Legend className="text-latent">Latent value</Legend>

                <p className="latent-panel denomination mt-5 text-5xl text-reverse sm:text-6xl">
                  Seven years
                </p>
                <p className="mt-4 text-sm leading-relaxed text-reverse-dim">
                  of on-time payments, steady income and clean obligations —
                  the thing that stops counting the moment you change country,
                  and the thing this credential carries across.
                </p>

                <div className="mt-8 border-t border-reverse/15 pt-7">
                  <DataFieldGrid className="grid-cols-2">
                    <DataField label="Corridor" value="IND ⟷ SGP" />
                    <DataField label="Held by" value="The holder" />
                    <DataField label="Consent" value="Revocable" />
                    <DataField label="Basis" value="AA framework" />
                  </DataFieldGrid>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Microtext
        text="THIS CREDENTIAL IS ISSUED TO THE HOLDER AND MAY BE REVOKED BY THE HOLDER AT ANY TIME"
        repeat={16}
        className="px-5 pb-1 text-latent-line/55 sm:px-8 lg:px-12"
      />
      <GuillocheBand className="text-latent-line/35" height={18} />
    </section>
  );
}
