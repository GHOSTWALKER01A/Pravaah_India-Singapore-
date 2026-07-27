import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * The validity overprint. A note carries its status stamped across the face,
 * and PRODUCT.md requires that a roadmap module is labelled as roadmap
 * everywhere it appears — this is how that promise is kept visually.
 *
 * `In service` uses the field colour; `Being built` uses the second-colour
 * iris print, because that is the fact a reader must not miss.
 */
export function StatusMark({
  status,
  tone = "rag",
  className,
}: {
  status: "live" | "roadmap";
  tone?: "rag" | "field";
  className?: string;
}): ReactElement {
  const live = status === "live";

  return (
    <span
      className={cn(
        "legend inline-flex shrink-0 items-center gap-1.5 border px-2 py-1",
        live
          ? tone === "field"
            ? "border-latent-line/55 text-latent"
            : "border-intaglio/35 text-intaglio"
          : tone === "field"
            ? "border-reverse-dim/40 text-reverse-dim"
            : "border-carmine/40 text-carmine",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1 w-1",
          live ? "bg-current" : "border border-current bg-transparent",
        )}
      />
      {live ? "In service" : "Being built"}
    </span>
  );
}
