import type { ReactElement } from "react";

import { Legend } from "@/ui/primitives/Legend";

/**
 * What happens after the checks — including the outcomes people are actually
 * anxious about. A "how to apply" page that only describes the happy path has
 * not answered the question the reader came with.
 *
 * Statuses are the real ones the system uses (see the KYC flow in
 * apps/pravaah-rn), not reassuring inventions.
 */
const OUTCOMES: ReadonlyArray<{
  status: string;
  meaning: string;
  next: string;
  tone: "pass" | "wait" | "stop";
}> = [
  {
    status: "Verified",
    meaning: "Every required check cleared.",
    next: "You can grant consent and have your financial history collected. This is the gate to everything downstream.",
    tone: "pass",
  },
  {
    status: "In review",
    meaning:
      "A check needs a person to look at it — most often a name that nearly matches but not exactly.",
    next: "Nothing is required from you while it is queued. Names transliterate badly across scripts and initials legitimately vary between a PAN, an Aadhaar record and a bank account, so a partial mismatch goes to a reviewer instead of a rejection.",
    tone: "wait",
  },
  {
    status: "Retry",
    meaning:
      "A check did not complete — a mistyped number, a timed-out session, a selfie the light defeated.",
    next: "You stay on that step and try again. The flow does not move past an unverified check, so nothing later is built on a bad foundation.",
    tone: "wait",
  },
  {
    status: "Failed",
    meaning:
      "A check returned a definite negative — for example a sanctions match, or a document that is not yours.",
    next: "We tell you which check failed. Where the law permits us to explain the reason, we do.",
    tone: "stop",
  },
];

/** Struck panels, as a note overprints a status. Never a thick edge stripe. */
const TONE: Record<"pass" | "wait" | "stop", string> = {
  pass: "bg-intaglio text-reverse",
  wait: "border border-intaglio/40 text-intaglio",
  stop: "border border-carmine/50 text-carmine-deep",
};

export function Outcomes(): ReactElement {
  return (
    <div>
      <Legend as="h2" className="text-intaglio-mid" rule>
        What the outcome can be
      </Legend>

      <dl className="mt-10 grid gap-px border border-intaglio/20 bg-intaglio/20 sm:grid-cols-2">
        {OUTCOMES.map((outcome) => (
          <div key={outcome.status} className="bg-rag p-7 sm:p-8">
            <dt>
              <span
                className={`legend inline-block px-2.5 py-1 ${TONE[outcome.tone]}`}
              >
                {outcome.status}
              </span>
              <span className="mt-4 block text-[0.9375rem] font-semibold leading-relaxed text-intaglio-deep">
                {outcome.meaning}
              </span>
            </dt>
            <dd className="mt-3 text-sm leading-relaxed text-ink">
              {outcome.next}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
