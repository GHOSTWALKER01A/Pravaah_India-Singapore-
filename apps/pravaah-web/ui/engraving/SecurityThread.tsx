import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * The security thread — a thread woven through the paper, unbroken edge to
 * edge. Here it is the visual spine of the capture column, and it carries the
 * page's one authored motion: it draws downward as the column scrolls,
 * scroll-linked via `animation-timeline: view()` in globals.css.
 *
 * The thread is decorative reinforcement of a relationship stated in text, so
 * it is hidden from assistive tech. Browsers without scroll-driven animations,
 * and anyone who has asked for reduced motion, get the fully drawn thread —
 * never a missing one.
 */
export function SecurityThread({
  className,
  animate = true,
}: {
  className?: string;
  animate?: boolean;
}): ReactElement {
  return (
    <div
      className={cn("pointer-events-none w-px", className)}
      aria-hidden="true"
    >
      <div
        className={cn(
          "h-full w-px",
          animate && "thread-run",
          // Dashed, because a security thread surfaces and dives back into
          // the paper rather than lying on top of it.
          "bg-[repeating-linear-gradient(to_bottom,currentColor_0,currentColor_9px,transparent_9px,transparent_15px)]",
        )}
      />
    </div>
  );
}
