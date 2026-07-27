import type { ComponentPropsWithoutRef, ReactElement } from "react";

import { cn } from "@/lib/utils";

/** The sheet's trim size. Every region aligns to this edge. */
export function Container({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">): ReactElement {
  return (
    <div
      className={cn("mx-auto w-full max-w-6xl px-5 sm:px-8 lg:px-12", className)}
      {...props}
    />
  );
}
