import type { ReactElement } from "react";

import { CaptureColumn } from "@/ui/home/CaptureColumn";
import { Chain } from "@/ui/home/Chain";
import { Close } from "@/ui/home/Close";
import { Face } from "@/ui/home/Face";
import { Holds } from "@/ui/home/Holds";
import { Problem } from "@/ui/home/Problem";

/**
 * The introduction.
 *
 * Reading order is the visitor's own question order (PRODUCT.md §Users):
 * what is this → why does it matter to me → is it safe and how does the data
 * move → what do I end up with → what is actually built → what do I do next.
 *
 * `Holds` was added because the fourth question had no answer anywhere on the
 * site. The page explained the border problem and the aggregator rail and then
 * jumped straight to the module architecture, which describes a data pipeline
 * and leaves the reader to infer the product. It sits after the mechanism and
 * before the chain deliberately: it is the payoff the mechanism buys, and the
 * chain is the evidence that the payoff exists.
 *
 * Root metadata already covers this route, so no page-level export is needed.
 */
export default function HomePage(): ReactElement {
  return (
    <>
      <Face />
      <Problem />
      <CaptureColumn />
      <Holds />
      <Chain />
      <Close />
    </>
  );
}
