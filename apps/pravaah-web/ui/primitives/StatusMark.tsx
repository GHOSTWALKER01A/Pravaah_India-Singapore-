import type { ReactElement } from "react";

import type { ModuleStatus, RailStatus } from "@/lib/content/chain";
import { cn } from "@/lib/utils";

/**
 * The validity overprint. A note carries its status stamped across the face,
 * and PRODUCT.md requires that the stage of a module is legible everywhere it
 * appears — this is how that promise is kept visually.
 *
 * The vocabulary changed once all eight modules were finished, and the change
 * matters: "In service / Being built" implied the honest question was whether
 * the code exists. It does. The honest question now is whether the regulated
 * rail behind it is the real one, which is a different axis — so module stage
 * is `StatusMark` and rail stage is {@link RailMark}, and neither is allowed to
 * stand in for the other.
 */
export function StatusMark({
  status,
  tone = "rag",
  className,
}: {
  status: ModuleStatus;
  tone?: "rag" | "field";
  className?: string;
}): ReactElement {
  const built = status === "built";

  return (
    <span
      className={cn(
        "legend inline-flex shrink-0 items-center gap-1.5 border px-2 py-1",
        built
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
          built ? "bg-current" : "border border-current bg-transparent",
        )}
      />
      {built ? "Built · verified" : "Being built"}
    </span>
  );
}

/**
 * Whether the third party behind a module is the real one.
 *
 * `none` prints nothing. A badge on every row saying "no external dependency"
 * is noise, and the absence reads correctly on its own: the rows that carry a
 * sandbox mark are the rows with something outstanding. The second colour is
 * used because that is the fact a reader deciding whether to trust this must
 * not skim past.
 */
export function RailMark({
  rail,
  tone = "rag",
  className,
}: {
  rail: RailStatus;
  tone?: "rag" | "field";
  className?: string;
}): ReactElement | null {
  if (rail === "none") return null;

  return (
    <span
      className={cn(
        "legend inline-flex shrink-0 items-center gap-1.5 border border-dashed px-2 py-1",
        tone === "field"
          ? "border-reverse-dim/50 text-reverse-dim"
          : "border-carmine/45 text-carmine",
        className,
      )}
    >
      Sandbox rail
    </span>
  );
}
