import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * Microtext — real repeated text at the threshold of legibility, exactly as
 * printed on a note. It is genuine content, not a texture: put a lens on it
 * and it says something true about the product.
 *
 * Always `aria-hidden`. A screen reader encountering the same phrase eighty
 * times is being harmed, not informed, and the phrase is always stated in
 * full elsewhere on the page.
 */
export function Microtext({
  text,
  repeat = 24,
  className,
}: {
  text: string;
  repeat?: number;
  className?: string;
}): ReactElement {
  const line = `${text} · `.repeat(repeat);

  return (
    <div
      className={cn("microtext overflow-clip", className)}
      aria-hidden="true"
    >
      {line}
    </div>
  );
}
