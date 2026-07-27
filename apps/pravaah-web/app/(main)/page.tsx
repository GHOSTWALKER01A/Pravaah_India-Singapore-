import type { ReactElement } from "react";

import { CaptureColumn } from "@/ui/home/CaptureColumn";
import { Chain } from "@/ui/home/Chain";
import { Close } from "@/ui/home/Close";
import { Face } from "@/ui/home/Face";
import { Problem } from "@/ui/home/Problem";

/**
 * The introduction.
 *
 * Reading order is the visitor's own question order (PRODUCT.md §Users):
 * what is this → why does it matter to me → is it safe and how does the data
 * move → what is actually built → what do I do next.
 *
 * Root metadata already covers this route, so no page-level export is needed.
 */
export default function HomePage(): ReactElement {
  return (
    <>
      <Face />
      <Problem />
      <CaptureColumn />
      <Chain />
      <Close />
    </>
  );
}
