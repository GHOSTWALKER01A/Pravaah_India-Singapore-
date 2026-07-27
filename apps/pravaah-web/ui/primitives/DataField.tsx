import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A field from the note's data grid: a wide-tracked label above a monospaced
 * value. Mono is used here for what mono is for — an identifier, a date, a
 * measurement — never as a costume for "technical".
 *
 * Rendered as a description list so the label/value relationship survives
 * being read aloud.
 */
export function DataFieldGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return <dl className={cn("grid gap-x-8 gap-y-6", className)}>{children}</dl>;
}

export function DataField({
  label,
  value,
  tone = "field",
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: "field" | "rag";
  className?: string;
}): ReactElement {
  return (
    <div className={cn("min-w-0", className)}>
      <dt
        className={cn(
          "legend",
          tone === "field" ? "text-reverse-dim" : "text-intaglio-mid",
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "field-value mt-2 text-sm break-words sm:text-[0.9375rem]",
          tone === "field" ? "text-reverse" : "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
