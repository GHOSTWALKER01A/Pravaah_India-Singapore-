import type { ReactElement } from "react";

import { AA_ROLES, CONSENT_STEPS } from "@/lib/content/chain";
import { cn } from "@/lib/utils";
import { Container } from "@/ui/layout/Container";
import { Guilloche } from "@/ui/engraving/Guilloche";
import { SecurityThread } from "@/ui/engraving/SecurityThread";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The capture column — the page's structural spine, and the section that has
 * to do the hardest teaching on the site.
 *
 * Scattered institutions at the top, combed through the consent gate in the
 * middle, arriving as one sealed stream at the base. The security thread runs
 * the full height and draws downward on scroll: the page's single authored
 * motion. Pravaah means flow, and the scroll is that flow.
 *
 * The Account Aggregator is the product's real differentiator, so it is taught
 * in three words rather than abstracted away.
 */

/** Institutions a person's history is actually scattered across. */
const SOURCES: readonly string[] = [
  "Salary account",
  "Savings account",
  "Fixed deposits",
  "Recurring deposits",
  "GST / business income",
  "Second bank",
];

export function CaptureColumn(): ReactElement {
  return (
    <section
      id="how-it-works"
      className="relative overflow-hidden bg-intaglio py-20 text-reverse sm:py-28"
    >
      <Container>
        <div className="max-w-3xl">
          <Legend className="text-latent" rule>
            How the data reaches us
          </Legend>
          <h2 className="denomination mt-8 text-[2.25rem] text-reverse sm:text-5xl lg:text-[3.5rem]">
            We never ask for your bank password. There is nowhere to type one.
          </h2>
          <p className="mt-7 text-base leading-relaxed text-reverse-dim sm:text-lg">
            India built a regulated rail for exactly this problem: a licensed
            broker that carries financial data between institutions on the
            instruction of the person the data belongs to. Three words make the
            whole thing legible.
          </p>
        </div>

        {/* The three roles. Set as a definition list because that is what it
            is — the reader is learning vocabulary, and vocabulary read aloud
            should still pair term with meaning. */}
        <dl className="mt-14 grid gap-px border border-reverse/20 bg-reverse/20 sm:mt-16 sm:grid-cols-3">
          {AA_ROLES.map((role) => (
            <div key={role.abbr} className="bg-intaglio p-7 sm:p-8">
              <dt className="denomination text-4xl text-latent sm:text-5xl">
                {role.abbr}
              </dt>
              <dd className="mt-4">
                <span className="legend block text-reverse-dim">
                  {role.expands}
                </span>
                <span className="mt-3.5 block text-[0.9375rem] leading-relaxed text-reverse">
                  {role.is}
                </span>
                <span className="mt-2 block text-[0.9375rem] leading-relaxed text-latent">
                  {role.here}
                </span>
              </dd>
            </div>
          ))}
        </dl>

        {/* ── The column itself ─────────────────────────────────────────── */}
        <div className="relative mt-24 sm:mt-32">
          {/* The thread sits on the column's axis: hard left on narrow screens,
              and from lg up at the grid boundary 15rem in — where a note's
              thread actually runs, about a third across. Centring it would
              leave half the sheet empty. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-1.75 top-0 flex text-latent-line/70 lg:left-60"
          >
            <SecurityThread className="h-full" />
          </div>

          <div className="flex flex-col gap-20 sm:gap-24">
            {/* Diffuse: history scattered across institutions. */}
            <ColumnStage
              stage="Diffuse"
              title="Your history is scattered"
              body="No single institution holds the whole picture. Your salary is in one place, your deposits in another, your business income somewhere else entirely. Assembled by hand, this is weeks of statements and stamped letters."
            >
              <ul className="mt-7 flex flex-wrap gap-2.5">
                {SOURCES.map((source) => (
                  <li
                    key={source}
                    className="legend border border-reverse/25 px-3.5 py-2 text-reverse-dim"
                  >
                    {source}
                  </li>
                ))}
              </ul>
            </ColumnStage>

            {/* The gate: consent. The narrowest point of the column. */}
            <ColumnStage
              stage="The gate"
              title="Nothing moves until you say so"
              body="Pravaah submits a request naming the data, the purpose, the period it covers, and how long we may keep it. You see that request in plain language on the aggregator's own screen — not ours — and you approve it or you refuse it."
              emphasis
            >
              <div className="relative mt-8 border border-latent-line/40 bg-intaglio-deep/60 p-7 sm:p-9 notch-lg">
                {/* Faded downward: the lathe work belongs behind the panel's
                    head, not under six numbered lines of body copy. */}
                <Guilloche
                  seed={1}
                  bands={4}
                  className="absolute inset-0 h-full w-full text-latent-line/18 [mask-image:linear-gradient(to_bottom,black,transparent_45%)]"
                />
                <ol className="relative flex flex-col gap-6">
                  {CONSENT_STEPS.map((step, index) => (
                    <li key={step.step} className="flex gap-5">
                      {/* The order is load-bearing here — each step is only
                          possible after the previous one — so it is numbered. */}
                      <span
                        aria-hidden="true"
                        className="field-value shrink-0 pt-0.5 text-xs text-latent"
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>
                        <span className="block text-[0.9375rem] font-semibold text-reverse">
                          {step.step}
                        </span>
                        <span className="mt-1.5 block text-[0.9375rem] leading-relaxed text-reverse-dim">
                          {step.body}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </ColumnStage>

            {/* Concentrated: one sealed stream. */}
            <ColumnStage
              stage="Sealed"
              title="It arrives encrypted, and only what you approved"
              body="Your bank encrypts the payload before it leaves. It travels through the aggregator sealed and is opened on our servers. The aggregator brokers the permission and carries the envelope — it cannot read what is inside. Data outside the scope you approved is never requested, so it never travels at all."
            />

            {/* The stream: normalised, and revocable. */}
            <ColumnStage
              stage="Yours to end"
              title="Revoke, and it is deleted"
              body="Every consent carries an expiry fixed at the moment you grant it. When that period ends the data is deleted automatically — nobody has to remember. Revoke earlier and deletion happens immediately. This is not a promise we make; it is how the system is built."
              emphasis
              last
            />
          </div>
        </div>
      </Container>
    </section>
  );
}

/**
 * One stage of the capture column. Content sits clear of the thread on the
 * left at narrow widths, and alternates around it from lg up — which is what
 * makes the column read as a descent rather than as a list.
 */
function ColumnStage({
  stage,
  title,
  body,
  children,
  emphasis = false,
  last = false,
}: {
  stage: string;
  title: string;
  body: string;
  children?: ReactElement;
  emphasis?: boolean;
  last?: boolean;
}): ReactElement {
  return (
    // 13rem legend column + 4rem gap puts the boundary — and the thread — at
    // 15rem, matching the absolutely positioned thread above.
    <div className="relative pl-9 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16 lg:pl-0">
      {/* The node where the thread surfaces. The terminus is struck solid and
          ringed, the way a note marks the end of a printed rule. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-2 h-3.5 w-3.5 border lg:left-60 lg:-translate-x-1/2",
          emphasis ? "border-latent bg-latent" : "border-latent-line/70 bg-intaglio",
          last && "ring-1 ring-latent-line/40 ring-offset-4 ring-offset-intaglio",
        )}
      />

      <div className="lg:col-start-1 lg:pr-6 lg:text-right">
        <Legend className={emphasis ? "text-latent" : "text-reverse-dim"}>
          {stage}
        </Legend>
      </div>

      <div className="mt-4 min-w-0 lg:col-start-2 lg:mt-0 lg:pl-6">
        <h3 className="denomination max-w-2xl text-2xl text-reverse sm:text-3xl">
          {title}
        </h3>
        <p className="mt-4 max-w-2xl text-[0.9375rem] leading-relaxed text-reverse-dim sm:text-base">
          {body}
        </p>
        {children}
      </div>
    </div>
  );
}
