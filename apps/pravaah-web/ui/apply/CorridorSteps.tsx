"use client";

import { useId, useState, type ReactElement } from "react";

import {
  CORRIDORS,
  checksFor,
  type CorridorId,
} from "@/lib/content/corridor-checks";
import { cn } from "@/lib/utils";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The applicant's real sequence, per corridor.
 *
 * The check list and its order come from apps/pravaah-rn/src/features/kyc —
 * this page promises a sequence, so it renders the one that ships rather than
 * a generic KYC list. The corridor selector exists because the sequences
 * genuinely differ: an Indian applicant does six steps, a Singapore applicant
 * four, and someone established on both sides does seven.
 *
 * Numbered, because the order is enforced: a failed PAN keeps you on PAN and
 * the flow never skips ahead of an unverified step.
 */
export function CorridorSteps(): ReactElement {
  const [corridor, setCorridor] = useState<CorridorId>("INDIA");
  const groupId = useId();
  const checks = checksFor(corridor);
  const selected = CORRIDORS.find((entry) => entry.id === corridor);

  return (
    <div>
      {/* Corridor selector. Radios, not tabs — this is a statement about the
          applicant, and it should read as one when spoken aloud. */}
      <fieldset>
        <Legend as="legend" className="text-intaglio-mid">
          Which side are you established on?
        </Legend>

        <div className="mt-5 grid gap-px border border-intaglio/25 bg-intaglio/25 sm:grid-cols-3">
          {CORRIDORS.map((entry) => {
            const active = entry.id === corridor;
            const id = `${groupId}-${entry.id}`;

            return (
              <div key={entry.id} className="relative bg-rag">
                <input
                  type="radio"
                  id={id}
                  name={groupId}
                  value={entry.id}
                  checked={active}
                  onChange={() => setCorridor(entry.id)}
                  className="peer absolute h-0 w-0 opacity-0"
                />
                <label
                  htmlFor={id}
                  className={cn(
                    "flex h-full cursor-pointer flex-col gap-2 p-6 transition-colors duration-200",
                    "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[-3px] peer-focus-visible:outline-latent",
                    active
                      ? "bg-intaglio text-reverse"
                      : "hover:bg-rag-shade/70",
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span
                      className={cn(
                        "denomination text-2xl",
                        active ? "text-reverse" : "text-intaglio-deep",
                      )}
                    >
                      {entry.label}
                    </span>
                    <span
                      className={cn(
                        "field-value text-xs",
                        active ? "text-latent" : "text-intaglio-mid",
                      )}
                    >
                      {checksFor(entry.id).length} steps
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-sm leading-relaxed",
                      active ? "text-reverse-dim" : "text-intaglio-mid",
                    )}
                  >
                    {entry.who}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      {/* The sequence. aria-live so a change of corridor is announced rather
          than silently swapping the list under a screen-reader user. */}
      <div aria-live="polite" className="mt-14">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-b border-intaglio/25 pb-4">
          <Legend className="text-intaglio-mid">
            {selected?.label} corridor · {checks.length} required checks, in
            order
          </Legend>
          <Legend className="text-carmine">
            Every check must clear before you are verified
          </Legend>
        </div>

        <ol className="mt-2">
          {checks.map((check, index) => (
            <li
              key={check.id}
              className="grid gap-y-5 border-b border-intaglio/15 py-9 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:gap-x-8 lg:grid-cols-[3.5rem_minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-12"
            >
              <span className="denomination text-3xl text-carmine sm:text-4xl">
                {String(index + 1).padStart(2, "0")}
              </span>

              <div>
                <h3 className="denomination text-[1.375rem] text-intaglio-deep sm:text-2xl">
                  {check.label}
                </h3>
                <p className="legend mt-2 text-intaglio-mid">
                  {check.subtitle}
                </p>
                <p className="mt-5 text-[0.9375rem] leading-relaxed text-ink">
                  {check.action}
                </p>
              </div>

              <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1 lg:border-l lg:border-intaglio/15 lg:pl-8">
                <div>
                  <dt className="legend text-intaglio-mid">What it proves</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-ink">
                    {check.proves}
                  </dd>
                </div>
                <div className="grid gap-5 sm:grid-cols-1 lg:grid-cols-2">
                  <div>
                    <dt className="legend text-intaglio-mid">
                      What you need
                    </dt>
                    <dd className="mt-2 text-sm leading-relaxed text-ink">
                      {check.needs}
                    </dd>
                  </div>
                  <div>
                    <dt className="legend text-intaglio-mid">Time</dt>
                    <dd className="field-value mt-2 text-sm text-ink">
                      {check.duration}
                    </dd>
                  </div>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
