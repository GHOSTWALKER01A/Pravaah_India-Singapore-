import Link from "next/link";
import type { ReactElement } from "react";

import { ROUTES } from "@/lib/constants/routes";
import { cn } from "@/lib/utils";
import { Seal } from "@/ui/engraving/Seal";

/**
 * The wordmark: the seal, then the name in the engraved didone.
 *
 * The etymology line that used to sit beneath the name is gone. It was doing a
 * teaching job the mark now does better — a logotype is what tells a reader
 * they are in the right place, and a nine-pixel gloss underneath the name was
 * competing with it for the same glance.
 *
 * The seal is decorative here, deliberately: the name sits beside it in real
 * text, so it is already in the accessibility tree and announcing the mark
 * again would be noise. The link carries the only label.
 */
export function Wordmark({
  className,
  tone = "rag",
}: {
  className?: string;
  tone?: "rag" | "field";
}): ReactElement {
  return (
    <Link
      href={ROUTES.HOME}
      className={cn("group inline-flex items-center gap-2.5", className)}
      aria-label="MyPravaah — home"
    >
      {/* Struck in the field colour on rag and in gold on the field — the two
          grounds the mark is specified for in brand/README.md. */}
      <Seal
        size={26}
        className={cn(
          "transition-opacity duration-200 group-hover:opacity-80",
          tone === "field" ? "text-latent-line" : "text-intaglio",
        )}
      />
      <span
        className={cn(
          "denomination text-[1.375rem] leading-none",
          tone === "field" ? "text-reverse" : "text-intaglio-deep",
        )}
      >
        MyPravaah
      </span>
    </Link>
  );
}
