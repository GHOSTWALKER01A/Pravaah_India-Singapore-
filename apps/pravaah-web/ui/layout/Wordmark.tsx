import Link from "next/link";
import type { ReactElement } from "react";

import { ROUTES } from "@/lib/constants/routes";
import { cn } from "@/lib/utils";

/**
 * The wordmark, set as a note sets its issuing authority: the name in the
 * engraved didone, the meaning beneath it in engraver's gothic. Pravaah is
 * Sanskrit for "flow", and saying so is the cheapest way to teach the name.
 */
export function Wordmark({
  className,
  tone = "rag",
  withMeaning = true,
}: {
  className?: string;
  tone?: "rag" | "field";
  withMeaning?: boolean;
}): ReactElement {
  return (
    <Link
      href={ROUTES.HOME}
      className={cn("group inline-flex flex-col gap-0.5", className)}
      aria-label="Pravaah — home"
    >
      <span
        className={cn(
          "denomination text-[1.375rem] leading-none",
          tone === "field" ? "text-reverse" : "text-intaglio-deep",
        )}
      >
        Pravaah
      </span>
      {withMeaning ? (
        <span
          className={cn(
            "legend text-[0.5625rem]",
            tone === "field" ? "text-reverse-dim" : "text-intaglio-mid",
          )}
        >
          Sanskrit · flow
        </span>
      ) : null}
    </Link>
  );
}
