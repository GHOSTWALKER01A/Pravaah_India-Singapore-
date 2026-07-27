import type { ElementType, ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The issuing-authority line. On a note this is RESERVE BANK OF INDIA set in
 * wide engraver's gothic; here it labels sections, fields and panels.
 *
 * DESIGN.md permits this as the site's one named kicker system — it is the
 * note's own grammar, used consistently, not a tracked eyebrow bolted above
 * every heading. Sections that do not need an issuing line do not get one.
 */
export function Legend({
  children,
  className,
  as: Tag = "p" as ElementType,
  rule = false,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  /** The hairline a note runs beneath its legend. */
  rule?: boolean;
} & Omit<
  React.HTMLAttributes<HTMLElement>,
  "children" | "className"
>): ReactElement {
  return (
    <Tag
      className={cn("legend", rule && "flex items-center gap-3", className)}
      {...rest}
    >
      <span>{children}</span>
      {rule ? (
        <span aria-hidden="true" className="h-px flex-1 bg-current opacity-30" />
      ) : null}
    </Tag>
  );
}
