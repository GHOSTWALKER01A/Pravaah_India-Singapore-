import type { ReactElement } from "react";

import { ROUTES } from "@/lib/constants/routes";
import { Container } from "@/ui/layout/Container";
import { ButtonLink } from "@/ui/primitives/Button";
import { DataField, DataFieldGrid } from "@/ui/primitives/DataField";
import { Legend } from "@/ui/primitives/Legend";

/**
 * What the holder ends up holding.
 *
 * The section the site was missing entirely. Everything before this explains a
 * mechanism — the thin-file problem, the aggregator rail — and the reader's next
 * question is the obvious one nobody was answering: so what do I have at the
 * end of it? Without this, the site described a data pipeline and left the
 * person to infer the product.
 *
 * Composition is the note's **counter panel**: a run of second-colour counters,
 * each stating a possession rather than a feature. "A score you can argue with"
 * is a thing you have; "explainable scoring" is a thing we do. The distinction
 * is the whole product — PRODUCT.md's third principle is that any design
 * reading as "we hold your score and grant you access" contradicts it — so the
 * grammar of this section is deliberately possessive throughout.
 *
 * Not numbered. The order here carries no information the reader needs, and
 * DESIGN.md permits ordered numbering only where it does.
 */

const HOLDINGS: ReadonlyArray<{
  serial: string;
  title: string;
  body: string;
}> = [
  {
    serial: "ID",
    title: "A MyPravaah ID",
    body: "A permanent public identifier — PVH-4K7Q-M2XB-9T3F — that you can read down a phone line without spelling it out. It carries a check character, so a mistyped digit is caught before it becomes a lookup against the wrong person. Nothing about you is encoded in it.",
  },
  {
    serial: "VER",
    title: "A verified identity you prove once",
    body: "Six checks, in one sitting. Nothing is asked of you twice, and being verified grants us nothing on its own.",
  },
  {
    serial: "SCR",
    title: "An answer with its reasons",
    body: "A figure on a 300–900 scale, the band it falls in, an honest confidence interval that widens when your data is thin, the five things moving it most, and the specific changes that would raise it — with the gain each is worth. Nobody is refused in silence.",
  },
  {
    serial: "RCP",
    title: "A reputation receipt in your own wallet",
    body: "Signed by us, bound to a key on your device, and yours. It expires, and you can revoke it. You choose which claims a lender sees, one by one; what you withhold is shown to them as withheld rather than read as a no. A refusal at one lender becomes a re-application at the next without starting over.",
  },
  {
    serial: "CRD",
    title: "A card for a desk with no integration",
    body: "A printed receipt card with a machine-readable zone, an NFC payload and a verify address. A branch with a phone and no system can still check it.",
  },
  {
    serial: "LOG",
    title: "A record of everyone who looked",
    body: "Every check against your receipt, the claims that left your wallet, who asked, and what the partner decided. You can revoke the whole receipt and it stops verifying for everyone at once.",
  },
  {
    serial: "PAY",
    title: "A UPI wallet with a real statement",
    body: "Send and collect over UPI, with payees, QR and autopay. A statement that shows ledger lines — the reserve, the fee, the refund — rather than a tidied summary, because that is the document that answers you when a balance is disputed.",
  },
  {
    serial: "COV",
    title: "Cover priced on your record",
    body: "Small-ticket income protection and a health top-up, explained in a sentence and declined in a tap. A higher rate arrives with the reason and with what would change it. A decline arrives as an answer, not an error.",
  },
  {
    serial: "SEC",
    title: "Every security decision, in writing",
    body: "Your registered devices, and a plain-language log of every judgement made about you — including the ones that let you through. A log showing only refusals would be a charge sheet, not a record.",
  },
  {
    serial: "DEL",
    title: "The delete button, and it is real",
    body: "Revoke a consent and the data behind it is deleted immediately. Let it run and it expires on its own, on a date fixed the moment you agreed. Neither depends on us remembering, or on you emailing anyone.",
  },
];

export function Holds(): ReactElement {
  return (
    <section className="border-b border-intaglio/12 bg-rag-shade/55 py-20 sm:py-28">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] lg:gap-20">
          <div className="max-w-2xl">
            <Legend className="text-intaglio-mid" rule>
              What you end up holding
            </Legend>
            <h2 className="denomination mt-8 text-[2.25rem] text-intaglio-deep sm:text-5xl lg:text-[3.5rem]">
              Not access to your reputation. Possession of it.
            </h2>
            <p className="mt-7 text-base leading-relaxed text-intaglio sm:text-lg">
              Every product in this space keeps your standing inside its own
              database and rents you a view of it. That is the one thing MyPravaah
              is built not to do — so this list is written as things you have,
              because that is what they are.
            </p>
          </div>

          {/* The holding plate. A note states its series and denomination in a
              reserved field; this states what the holding actually is. */}
          <aside className="border border-intaglio/25 bg-rag p-7 sm:p-8 notch-lg">
            <Legend className="text-carmine">The holding</Legend>
            <DataFieldGrid className="mt-6 grid-cols-2">
              <DataField tone="rag" label="Issued to" value="The holder" />
              <DataField tone="rag" label="Held by" value="Your device" />
              <DataField tone="rag" label="Shown to" value="Panel partners" />
              <DataField tone="rag" label="Scale" value="300 – 900" />
              <DataField tone="rag" label="Disclosure" value="Per claim" />
              <DataField tone="rag" label="Revocation" value="Immediate" />
            </DataFieldGrid>
          </aside>
        </div>

        <dl className="mt-16 grid gap-px border border-intaglio/20 bg-intaglio/20 sm:mt-20 sm:grid-cols-2">
          {HOLDINGS.map((holding) => (
            <div key={holding.serial} className="bg-rag p-7 sm:p-9">
              <dt>
                <span className="field-value block text-xs text-carmine">
                  {holding.serial}
                </span>
                <span className="denomination mt-2.5 block text-2xl text-intaglio-deep">
                  {holding.title}
                </span>
              </dt>
              <dd className="mt-3.5 text-[0.9375rem] leading-relaxed text-ink">
                {holding.body}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-14 flex flex-col gap-3 sm:flex-row sm:items-center">
          <ButtonLink href={ROUTES.WHAT_IS_BUILT}>
            What is built, in full
          </ButtonLink>
          <ButtonLink href={ROUTES.HOW_TO_APPLY} variant="secondary">
            What applying involves
          </ButtonLink>
        </div>
      </Container>
    </section>
  );
}
