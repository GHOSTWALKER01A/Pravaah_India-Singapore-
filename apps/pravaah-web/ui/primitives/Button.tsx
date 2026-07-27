import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Actions in the note's vocabulary: a struck panel with a notched corner and
 * the shallow relief of an intaglio impression. A stock rounded pill inside a
 * committed world is a lapse, so there isn't one.
 */

type Variant = "primary" | "secondary" | "reverse" | "quiet";

const BASE = cn(
  "legend notch inline-flex items-center justify-center gap-2.5 text-center",
  "px-6 py-3.5 transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
  "disabled:pointer-events-none disabled:opacity-45",
);

const VARIANTS: Record<Variant, string> = {
  // On rag: the field colour struck into the sheet.
  primary: cn(
    "bg-intaglio text-reverse impression",
    "hover:bg-intaglio-deep hover:-translate-y-px",
    "active:translate-y-0 active:bg-intaglio-deep",
  ),
  // On rag: engraved outline only.
  secondary: cn(
    "keyline bg-transparent text-intaglio",
    "hover:bg-intaglio hover:text-reverse hover:-translate-y-px",
    "active:translate-y-0",
  ),
  // On the field: reversed out.
  reverse: cn(
    "bg-rag text-intaglio-deep",
    "hover:bg-white hover:-translate-y-px",
    "active:translate-y-0",
  ),
  // On the field: outline only.
  quiet: cn(
    "keyline-reverse bg-transparent text-reverse",
    "hover:bg-reverse/12 hover:-translate-y-px",
    "active:translate-y-0",
  ),
};

export function ButtonLink({
  href,
  variant = "primary",
  className,
  children,
  external,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
  external?: boolean;
}): ReactElement {
  const classes = cn(BASE, VARIANTS[variant], className);

  if (external) {
    return (
      <a
        href={href}
        className={classes}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  variant?: Variant;
}): ReactElement {
  return (
    <button className={cn(BASE, VARIANTS[variant], className)} {...props}>
      {children}
    </button>
  );
}
