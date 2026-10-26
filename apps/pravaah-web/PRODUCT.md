# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — the thin-file applicant ("Rekha").** A 20–40 year old gig worker, small merchant or
new-to-credit salaried person who already transacts over UPI every day, has a thin or empty
bureau file, may read English poorly, and has been refused before without ever being told why.
The illustrative persona is Rekha: 29, runs a kirana counter, takes payments over UPI, no
credit card, one refusal with no reason given, needs ₹40,000 for three months of festival
stock. Rekha is a persona, not a customer; never present her as a testimonial.

The pain, in her words: *"I applied, they asked for documents I don't have, and then they said
no and nobody told me why."* Every part of the product answers one part of that sentence.

They arrive at this website to answer three questions, in this order:
1. Is this real and safe, or is it another app that wants my bank password?
2. What exactly happens to my data, and can I take it back?
3. What do I actually have to do, and will I at least be told why?

**Secondary (acknowledged, not served first).** Panel partners — banks, NBFCs and insurers —
who verify a reputation receipt and record a decision (module M7), and the judges of the Paytm
hackathon this build is entered in. Both are real audiences; neither is the audience the site
is written for. Do not restructure the site around them.

## Product Purpose

MyPravaah is an AI financial-journey copilot that turns a thin-file, anxious applicant into an
approved, insured, confident customer in one honest conversation — using consented data, not
documents.

Underneath the copilot is a trust/reputation system: prove who the person is (M0), pull their
financial history *only with their consent* (M1), turn it into an explainable score (M2), and
hand that score to the person as a signed **reputation receipt they own** (M3). A panel partner
can then verify that receipt and record a decision (M7). Money movement (M4) and small-ticket
insurance (M5) are downstream payoffs; fraud (M6) runs under everything. The copilot (M8)
orchestrates those modules as one conversation. It decides nothing.

Context: built for the **Paytm ♥ AI Hackathon · Build for India · Track 2 (AI-powered financial
journeys)**, 31 October 2026. The product was first built as a cross-border passport for the
India–Singapore corridor; that framing is retired. `CONTEXT` in `lib/config/site.ts` holds the
event details and the disclaimer that travels with the Paytm name everywhere it appears:
MyPravaah is an independent entry, not a Paytm product, not affiliated with or endorsed by Paytm.

Success for this website: a first-time visitor who has never heard of an Account Aggregator
understands what a reputation receipt is, believes the consent and deletion guarantees are
real, sees exactly which steps of the journey run today, and knows what applying will require.

## Positioning

The one line: *"We don't lend and we don't underwrite. We make the road to a lender's decision
honest."* Partners carry the capital and the risk; MyPravaah augments their decisioning and
the customer's journey. Never write "we lend", "we approve" or "we underwrite".

The mechanism a neighbouring product could not truthfully copy: **the receipt is held by the
user, not by us.** Credit products keep the score inside their own database and rent access to
it. MyPravaah issues a signed, tamper-evident receipt to the person, who can re-present it to the
next lender after a refusal without starting over — and who can revoke the underlying data at
any moment, after which it is deleted.

The second uncopyable fact: the data is obtained through India's regulated **Account
Aggregator** rail. MyPravaah never asks for a bank password, never screen-scrapes, and never
sees data the user did not explicitly consent to. The aggregator itself carries only a sealed
envelope — it cannot read the contents.

The third, in build: **AA data blended with UPI and merchant cash-flow signals.** AA alone is a
generic product; AA plus the payment record a bureau cannot see is what makes a thin file
measurable. Today that signal layer runs on seeded synthetic data, and the site says so.

Retired and not to be reintroduced: the India–Singapore corridor, Singpass/Myinfo, SGFinDex,
the UPI–PayNow link, dual currency and FX, migrant/remittance framing, and "passport" as the
product's name. (The code keeps `passport` identifiers; those are not copy.)

## Operating Context

The end-to-end journey the site must be able to describe truthfully:

**Identity (M0)** — PAN verification → Aadhaar OKYC via DigiLocker → bank penny-drop name match
→ liveness → face match → sanctions/PEP screening. Six checks, India only. A name mismatch routes
to human review; it does not auto-reject. A profile becomes `VERIFIED` only when every required
check clears. (The app and API still carry Singapore branches from the corridor build; they are
retired from the product and not presented.)

**Consent & data (M1)** — three roles: FIP (the bank, which holds the data), FIU (MyPravaah,
which wants it), AA (the licensed consent broker in between; Setu, behind a provider interface).
MyPravaah requests a named data scope, for a named purpose, over a named time window, with a
named retention period. The user approves or rejects on the aggregator's own screen. An active
consent produces a signed consent artefact. Data is encrypted bank-to-MyPravaah, decrypted
server-side, field-encrypted at rest, and normalised into features. It is auto-deleted when the
agreed data-life expires, and deleted immediately on revocation.

**Score (M2)** — normalised features → a 300–900 score with a confidence interval, a coverage
figure, ranked plain-language factors (exact Shapley attributions — in-process scorecard by
default, an XGBoost + TreeSHAP FastAPI service optionally), and ranked improvements with
re-computed point gains. Five distinct non-score states (no consent, insufficient data, pending,
expired, failed). A fairness gate runs on every model. Protected attributes for bias auditing
are a separate, optional consent whose values are never readable back out.

**Reputation receipt (M3)** — the score sealed into an SD-JWT verifiable credential, signed by
the issuer and bound to a key generated on the holder's device. Per-claim selective disclosure;
withheld claims are reported as withheld. It expires and is revocable. A printed card exists too
(MRZ, NFC payload, verify URL) for a desk with no integration.

**Panel verification (M7)** — signature, holder proof of possession, revocation status list and
a single-use nonce. A partner's request arrives in the holder's wallet for approval; the partner
API then records a decision (approved, declined, referred). A person can also scan a holder's
code and receive only ticked claims. A scan reveals nothing about the holder before approval.
The partner *web* view is not built.

**Payments (M4)** — domestic UPI (Decentro sandbox, or a simulator refused in production) on a
double-entry ledger with a trial balance asserted to zero. Quotes are frozen single-use priced
intents. Limits bucket in IST, and the annual cap follows the Indian financial year. Late
settlement reconciles rather than double-refunding.

**Insurance (M5)** — small-ticket income protection and health top-up, underwritten on the same
consented data. A higher rate carries its reason and what would change it; a decline is an
explained outcome. Claims carry documents, a review thread, and a payout into the wallet.
Offering cover at the loan moment is copilot work, in build.

**Fraud (M6)** — device binding, SIM-swap detection, velocity counters, a shared-artefact graph,
and step-up challenges, layered under every other module. Noisy-OR aggregation. Holds go to an
analyst queue with an SLA; the holder can read every decision, including allows.

**In build for the Paytm brief** — never described in the present tense:
- **Copilot (M8)** — an LLM agent running the journey as tool calls over the existing endpoints
  (`startKyc`, `requestConsent`, `fetchFinancialData`, `scoreApplicant`, `matchPanel`,
  `issueReceipt`, `quoteInsurance`/`bindPolicy`), Hindi and English, voice and chat, with a
  visible transcript. It may interpret, choose the next tool, explain and coach. It may never
  decide approval, limit or price, invent a reason, quote a term `matchPanel` did not return, or
  promise an outcome. Every tool call goes to the audit log with the copilot as actor.
- **Paytm-context signals** — UPI and merchant cash-flow features joined before scoring, behind a
  provider interface, on seeded synthetic data.
- **Panel matching** — a rules table of partner eligibility. A learned matcher is roadmap.

Related surfaces in the repo: `apps/pravaah-rn` (Expo holder app — deep-link scheme `parvaahrn`,
bundle id `com.pravaah.app`), `apps/pravaah-admin` (Next.js staff console — review queues for
KYC, consent, models, receipts, partners, payments, insurance and fraud), `apps/pravaah-be`
(NestJS API), `apps/ml` (FastAPI inference service).

## Capabilities and Constraints

**Eight modules are built and verified end-to-end (M0–M7); the ninth, the copilot, is in build.**
Each built module is exercised against the real database by a named, re-runnable check, and the
backend suite is 719 tests across 30 suites, all passing. The site may say this plainly, and it
must say in the same breath that the copilot is not built.

**None of it is a live financial service, and that must be stated wherever the first claim
is.** MyPravaah does not lend or underwrite, is not a licensed Financial Information User, holds
no payments licence or PSP agreement, and has no insurance risk carrier on paper. Those
integrations are finished and run against provider sandboxes. The Paytm-context signals are
synthetic. No real money has moved; no policy is in force.

Two separate axes, and conflating them is the specific dishonesty available here:
- **Module stage** — `built`, `building` or `roadmap`. Rendered by `StatusMark`.
- **Rail stage** — `sandbox` where a regulated third party is involved (M0, M1, M4, M5, M6),
  `synthetic` where seeded data stands in for a source we cannot access (the signal layer), and
  `none` otherwise. Rendered by `RailMark`.

`STAGE` in `lib/config/site.ts` is the single source for all of this. No page may state the
stage in its own prose.

**The mobile app is not published.** Every app-download surface is an explicitly labelled
pre-launch state. Store URLs are env-driven and empty; the deep-link plumbing (`parvaahrn://`) is
built and dormant.

**Provider abstraction.** Decentro (KYC and UPI), the AA provider (Setu), the payment rails, the
telco lookup and — in build — the Paytm signal source all sit behind interfaces; sandbox
implementations are swapped for live ones without touching business logic. This is why the
sandbox statement is a licensing gap rather than a code gap.

**Undecided / must not be invented.** Registered legal entity name and address, grievance
officer and DPO contact, RBI licence status, hosting region, security certifications (SOC 2, ISO
27001), launch date, pricing, user counts, panel partner names, any relationship with Paytm
beyond the hackathon entry, and any independent penetration test. These ship as clearly marked
placeholders.

## Brand Commitments

- Name: **MyPravaah**, one word, capital M and capital P. The repository, the packages, the
  bundle id (`com.pravaah.app`), the deep-link scheme (`parvaahrn://`) and the origin
  (`pravaah.app`) keep their existing spellings — those are identifiers, not the brand.
- **The etymology is not copy.** *Pravaah* is Sanskrit for flow — now a flow through a financial
  journey rather than across a border — and that is why the home page's spine is a descending
  column. It is not printed under the wordmark. Do not put it back as a tagline.
- The mark is the **guilloche rosette seal** in `brand/` — fourteen petals, nested lathe curves,
  generated from parameters. `ui/engraving/Seal.tsx` generates it; the constants are duplicated
  from `brand/build.mjs` and `apps/pravaah-rn`, so changing one means changing all three.
- The tagline: *"Prove yourself once, and keep the proof."* The close it comes from: *"She proved
  herself once, and she keeps the proof."*
- Voice: plain English over jargon, short sentences, Hindi where the copilot speaks. The site
  teaches FIP/FIU/AA in three lines rather than assuming them — explain the mechanism, never
  hide behind it.

## Evidence on Hand

- `PRAVAAH × Paytm — Build Bible` — the source for the reframe, the golden path, the copilot's
  tools and guardrails, and what to claim versus mark roadmap.
- `PRAVAAH-EXPLAINED-SIMPLE.md` and `M3-PASSPORT-EXPLAINED-SIMPLE.md` (repo root) — the
  plain-English narrative of the module chain and the AA explanation. Their corridor framing is
  superseded; their mechanism descriptions stand.
- **The shipped surfaces are the source of truth for capability copy**, ahead of any document —
  including the build bible, which lags the repository on M5, M6 and M7. In particular:
  - `apps/pravaah-rn/src/features/kyc/flow.ts` + `check-labels.ts` — the India check sequence.
    `/how-to-apply` mirrors it and must not drift.
  - `apps/pravaah-rn/src/features/*/​*-meta.ts` — the holder-facing vocabulary for score,
    payments, insurance and security.
  - `apps/pravaah-admin/features/routes.ts` — why each review queue exists.
- **Re-runnable checks**, listed on `/what-is-built` with their commands. Every claim of the
  form "this works" on the site should be traceable to one of them.
- **Absent, must not be fabricated:** testimonials, customer logos, press coverage, user
  numbers, screenshots of the unreleased app, benchmark scores, any certification badge, any
  Paytm endorsement, and any figure that cannot be re-derived from the repository.

## Product Principles

1. **Trust is the product, so the site's job is proof, not persuasion.** Every claim about
   consent, encryption, or deletion must be traceable to something the system actually does.
2. **Explain the rail, don't hide it.** The Account Aggregator is the hardest and most valuable
   idea here. Teaching it plainly is a differentiator.
3. **The user owns the receipt.** Any design that reads as "we hold your score and grant you
   access" contradicts the product.
4. **Nobody is declined in silence.** Every outcome carries its reason and the one change that
   would most improve it.
5. **The AI is the mechanism, and it never decides.** The copilot orchestrates and explains;
   deterministic systems decide. Say so wherever the copilot is described.
6. **Never overstate the stage — and never understate it either.** The copilot is not built and
   must not be described as if it were; eight modules are built and must not be hedged. Read
   `STAGE`, state every part, do not average them.
7. **A claim needs a check.** If a sentence on the site asserts that something works, there
   should be a command on `/what-is-built` that proves it.

## Accessibility & Inclusion

Audience is mobile-first, frequently on mid-range Android over mobile data, and reading English
as a second or third language. Implications treated as requirements: short sentences over dense
paragraphs, no jargon without an inline definition, real text over text-in-image, comfortable
tap targets, and legibility that survives a bright screen outdoors and a dim one at night. WCAG
2.2 AA contrast is the floor.
