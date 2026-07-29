import type { ReactElement } from "react";

import { EVIDENCE } from "@/lib/content/modules";
import { Legend } from "@/ui/primitives/Legend";

/**
 * Evidence, set as a numbered run.
 *
 * Numbered because the order IS information here — it runs from the broadest
 * check to the narrowest, which is the order somebody auditing the claim would
 * work through them. That is the one condition DESIGN.md puts on ordered
 * numbering.
 *
 * The command is set as a data-field value, in mono, because it is exactly what
 * mono is for on this site: something to be transcribed literally. It is the
 * only text on the page a reader is meant to copy.
 */
export function EvidenceList(): ReactElement {
  return (
    <div>
      <div className="max-w-3xl">
        {/* Legend is the issuing line; the heading is h2 and the items are h3,
            matching every other section on this page. */}
        <Legend className="text-latent" rule>
          How to check we are not lying
        </Legend>
        <h2 className="denomination mt-8 text-[2rem] text-reverse sm:text-[2.75rem]">
          Every claim on this page has something you can run.
        </h2>
        <p className="mt-7 text-base leading-relaxed text-reverse-dim sm:text-lg">
          A screenshot proves that something rendered. These drive the real
          service against the real database and fail loudly when the property
          they assert stops holding — which is the only kind of evidence worth
          offering to somebody who assumes we are exaggerating.
        </p>
      </div>

      <ol className="mt-14 border-t border-reverse/20">
        {EVIDENCE.map((item, index) => (
          <li
            key={item.title}
            className="grid gap-y-4 border-b border-reverse/15 py-9 sm:grid-cols-[3rem_minmax(0,1fr)] sm:gap-x-8"
          >
            <span
              aria-hidden="true"
              className="field-value text-xs text-latent sm:pt-1.5"
            >
              {String(index + 1).padStart(2, "0")}
            </span>

            <div className="min-w-0">
              <h3 className="denomination text-xl text-reverse sm:text-2xl">
                {item.title}
              </h3>
              <p className="mt-3 max-w-2xl text-[0.9375rem] leading-relaxed text-reverse-dim sm:text-base">
                {item.body}
              </p>

              {item.command ? (
                <p className="mt-5 inline-block max-w-full border border-latent-line/40 bg-intaglio-deep/50 px-4 py-2.5 notch-sm">
                  <code className="field-value text-xs text-latent sm:text-sm">
                    {item.command}
                  </code>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
