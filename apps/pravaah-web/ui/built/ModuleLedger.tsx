import type { ReactElement } from "react";

import { CONTEXT } from "@/lib/config/site";
import { ALL_MODULES, IN_BUILD, type ChainLink } from "@/lib/content/chain";
import { Legend } from "@/ui/primitives/Legend";
import { RailMark, StatusMark } from "@/ui/primitives/StatusMark";

/**
 * The eight built modules at full depth, in build order — then what is being
 * added, in the same ledger, under its own rule.
 *
 * A ledger rather than a grid of equal cards, for the reason DESIGN.md states:
 * the rows are not interchangeable. Each carries four different kinds of fact —
 * what it establishes, how, what the holder experiences, and what is still
 * outstanding — and a card that has to hold all four either truncates them or
 * becomes a paragraph with a heading, which is what the ledger already is
 * without pretending otherwise.
 *
 * Build order, not the chain order used on the home page. The home page is
 * arguing that the sequence is load-bearing; this page is answering "what
 * exists", and a reader auditing that wants M0 through M7 in the order they
 * were made. The in-build rows share the row component so they are measured
 * against the same four facts, and sit after a heavier rule so they can never
 * be read as a continuation of the built list.
 */
export function ModuleLedger(): ReactElement {
  return (
    <div>
      {/* Legend is the issuing line; the heading is h2 and the rows carry no
          heading of their own, because a definition term is what they are. */}
      <Legend className="text-latent" rule>
        The eight, in build order
      </Legend>

      <h2 className="denomination mt-8 max-w-3xl text-[2rem] text-reverse sm:text-[2.75rem]">
        Each one was finished before the next began, because each one needs the
        last.
      </h2>

      <p className="mt-7 max-w-2xl text-base leading-relaxed text-reverse-dim sm:text-lg">
        Where a module depends on a regulated third party, the limitation is
        printed on its own row rather than gathered into a disclaimer at the
        bottom of the page that nobody reads.
      </p>

      <dl className="mt-14 border-t border-reverse/20">
        {ALL_MODULES.map((module) => (
          <ModuleRow key={module.id} module={module} />
        ))}
      </dl>

      <div className="mt-20 border-t-2 border-latent-line/50 pt-14 sm:mt-24">
        <Legend className="text-latent">In build · for the Paytm brief</Legend>
        <h2 className="denomination mt-8 max-w-3xl text-[2rem] text-reverse sm:text-[2.75rem]">
          What is being added, and none of it is finished.
        </h2>
        <p className="mt-7 max-w-2xl text-base leading-relaxed text-reverse-dim sm:text-lg">
          One new module and two thin layers. The copilot calls the endpoints
          above rather than replacing any of them, so nothing it adds can reach
          a decision by a route the built modules do not already guard.
        </p>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-reverse-dim">
          {CONTEXT.event} · {CONTEXT.theme} · {CONTEXT.track}.{" "}
          {CONTEXT.disclaimer}
        </p>

        <dl className="mt-14 border-t border-reverse/20">
          {IN_BUILD.map((module) => (
            <ModuleRow key={module.id} module={module} />
          ))}
        </dl>
      </div>
    </div>
  );
}

function ModuleRow({ module }: { module: ChainLink }): ReactElement {
  return (
    <div className="grid gap-y-6 border-b border-reverse/15 py-10 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-x-16">
      <dt>
        <span className="field-value block text-xs text-latent">{module.id}</span>
        <span className="denomination mt-2 block text-[1.75rem] text-reverse sm:text-3xl">
          {module.name}
        </span>
        <span className="mt-3 block text-[0.9375rem] leading-relaxed text-latent">
          {module.claim}
        </span>
        <span className="mt-5 flex flex-wrap gap-2">
          <StatusMark status={module.status} tone="field" />
          <RailMark rail={module.rail} tone="field" />
        </span>
      </dt>

      <dd className="min-w-0">
        <p className="max-w-2xl text-[0.9375rem] leading-relaxed text-reverse sm:text-base">
          {module.detail}
        </p>

        <p className="mt-5 max-w-2xl border-l border-latent-line/45 pl-4 text-[0.9375rem] leading-relaxed text-reverse-dim">
          <span className="legend mb-1 block text-latent">
            {module.status === "built"
              ? "What the holder gets"
              : "What the holder will get"}
          </span>
          {module.holder}
        </p>

        {module.caveat ? (
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-reverse-dim">
            <span className="legend mb-1 block text-reverse-dim">Outstanding</span>
            {module.caveat}
          </p>
        ) : null}
      </dd>
    </div>
  );
}
