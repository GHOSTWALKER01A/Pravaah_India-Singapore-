# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — the individual holder ("Ravi").** A person who built a real financial life in
one country and is moving to another: migrant workers, international students, and founders
on the India ↔ Singapore corridor. The scene is concrete and adversarial — they have just
landed (or are about to), and the local financial system treats them as a stranger with no
history. No local credit file means no loan, a rejected rental application or a punitive
deposit, and blind-priced insurance. They are on a phone, often at night, often after a
rejection. Seven years of on-time payments died at the airport.

They arrive at this website to answer three questions, in this order:
1. Is this real and safe, or is it another app that wants my bank password?
2. What exactly happens to my data, and can I take it back?
3. What do I actually have to do, and what will it cost me in time and documents?

**Secondary (acknowledged, not served first).** Lenders, landlords, and insurers who will one
day verify a passport (module M7) are a real audience but are not the audience this site is
written for. Do not restructure the site around them.

## Product Purpose

MyPravaah lets a person carry their financial reputation across a border.

It is not a payments app. It is a trust/reputation system: prove who the person is (M0),
pull their financial history *only with their consent* (M1), turn it into an explainable
score (M2), and hand that score to the person as a signed, portable credential **they own**
(M3). A lender or landlord can then verify that credential (M7). Money movement (M4) and
insurance pricing (M5) are downstream payoffs, not the point.

Success for this website: a first-time visitor who has never heard of an Account Aggregator
understands what a reputation passport is, believes the consent and deletion guarantees are
real, and knows precisely what applying will require of them.

## Positioning

The mechanism a neighboring product could not truthfully copy: **the credential is held by
the user, not by us.** Competing credit and remittance products keep the score inside their
own database and rent access to it. MyPravaah issues a signed, tamper-evident credential to
the person, who can present it to any institution in any country — and who can revoke the
underlying data at any moment, after which it is deleted.

The second uncopyable fact: the data is obtained through India's regulated **Account
Aggregator** rail. MyPravaah never asks for a bank password, never screen-scrapes, and never
sees data the user did not explicitly consent to. The aggregator itself carries only a sealed
envelope — it cannot read the contents.

## Operating Context

The end-to-end journey the site must be able to describe truthfully:

**Identity (M0)** — required checks differ by corridor.
- India: PAN verification → Aadhaar OKYC via DigiLocker → bank penny-drop name match →
  liveness → face match → sanctions/PEP screening.
- Singapore: Singpass Myinfo → liveness → face match → sanctions/PEP screening.
- Both: the union of the two, Singpass inserted after the India bank check.
A name mismatch routes to human review; it does not auto-reject. A profile becomes
`VERIFIED` only when every required check clears.

**Consent & data (M1)** — three roles: FIP (the bank, which holds the data), FIU (MyPravaah,
which wants it), AA (the licensed consent broker in between). MyPravaah requests a named data
scope, for a named purpose, over a named time window, with a named retention period. The
user approves or rejects on the aggregator's own screen. An active consent produces a signed
consent artefact. Data is encrypted bank-to-MyPravaah, decrypted server-side, and normalised
into features. It is auto-deleted when the agreed data-life expires, and deleted immediately
on revocation.

**Score (M2)** — normalised features → a 300–900 score with a confidence interval, a coverage
figure, ranked plain-language factors, and ranked improvements with re-computed point gains.
Five distinct non-score states (no consent, insufficient data, pending, expired, failed),
each leading somewhere different. Protected attributes for bias auditing are a separate,
optional consent whose values are never readable back out.

**Passport (M3)** — the score sealed into an SD-JWT verifiable credential, signed by the
issuer and bound to a key generated on the holder's device. Per-claim selective disclosure;
withheld claims are reported as withheld. A physical card exists too (MRZ, NFC payload,
verify URL) for a counter with no app. Revocation kills it for everyone at once and destroys
the device key.

**Verification (M7)** — signature, holder proof of possession, revocation status list and a
single-use nonce. Two paths: a registered institution's request arrives in the holder's
wallet for approval, and a person can scan a holder's code and receive only ticked claims.
A scan reveals nothing about the holder before approval.

**Money movement (M4)** — UPI domestic and the UPI–PayNow link, on a double-entry ledger with
a trial balance asserted to zero. Quotes are frozen single-use priced intents. Limits bucket
in IST/SGT, and the annual cap follows the Indian financial year. Late settlement reconciles
rather than double-refunding.

**Insurance (M5)** — income protection, health top-up, travel accident, underwritten on the
same consented data. A higher rate carries its reason and what would change it; a decline is
an explained outcome. Claims carry documents, a review thread, and a payout into the wallet.

**Fraud (M6)** — device binding, SIM-swap detection, velocity counters, a shared-artefact
graph, and step-up challenges, layered under every other module. Noisy-OR aggregation. Holds
go to an analyst queue with an SLA; the holder can read every decision, including allows.

Related surfaces in the repo: `apps/pravaah-rn` (Expo holder app — every flow above,
deep-link scheme `parvaahrn`, bundle id `com.pravaah.app`), `apps/pravaah-admin` (Next.js
staff console — review queues for KYC, consent, models, credentials, payments, insurance and
fraud), `apps/pravaah-be` (NestJS API).

## Capabilities and Constraints

**All eight modules are built and verified end-to-end (M0–M7).** Not "working in a demo" —
each is exercised against the real database by a named, re-runnable check, and the backend
suite is 591 tests across 24 suites, all passing. The site may say this plainly. It is the
strongest honest claim available and it should not be hedged into meaninglessness.

**None of it is a live financial service, and that must be stated wherever the first claim
is.** MyPravaah is not a licensed Financial Information User, holds no payments licence or PSP
agreement, and has no insurance risk carrier on paper. Those integrations are finished and
run against provider sandboxes. No real money has moved; no policy is in force. A page that
states the achievement and defers this to a footer has chosen to be misread.

Two separate axes, and conflating them is the specific dishonesty available here:
- **Module stage** — all eight `built`. Rendered by `StatusMark`.
- **Rail stage** — `sandbox` where a regulated third party is involved (M0, M1, M4, M5, M6),
  `none` where the module depends on nobody (M2, M3, M7). Rendered by `RailMark`.

`STAGE` in `lib/config/site.ts` is the single source for all of this. No page may state the
stage in its own prose — the previous version hardcoded "identity and consent in service ·
scoring and passport in development" into a footer, a hero, a close, two legal documents and
an app page, and every one of those was wrong for as long as it took to build the other six
modules.

**The mobile app is not published.** There is no App Store or Play Store listing yet. Every
app-download surface must be an explicitly labelled pre-launch state. Store URLs are
env-driven and empty; the deep-link plumbing (`parvaahrn://`) is built and dormant. What
stands between the build and a release is licensing, not engineering — that framing is true
and may be used.

**Provider abstraction.** Decentro (India KYC), Singpass (Singapore identity), the AA
provider, the payment rails and the telco lookup all sit behind interfaces; sandbox
implementations are swapped for live ones without touching business logic. This is an
internal engineering fact, and it is the reason the sandbox statement above is a licensing
gap rather than a code gap.

**Undecided / must not be invented.** Registered legal entity name and address, grievance
officer and DPO contact, RBI or MAS licence status, security certifications (SOC 2, ISO
27001), launch date, pricing, user counts, partner names, and any independent penetration
test. These ship as clearly marked placeholders on the user's replacement list.

## Brand Commitments

- Name: **MyPravaah**, one word, capital M and capital P. The repository, the packages, the
  bundle id (`com.pravaah.app`), the deep-link scheme (`parvaahrn://`) and the origin
  (`pravaah.app`) keep their existing spellings — those are identifiers, not the brand, and
  renaming any of them breaks a real thing. Only the public-facing name changed.
- **The etymology is not copy.** *Pravaah* is Sanskrit for flow, and that is why the home
  page's spine is a descending column rather than a row of steps. It is no longer printed
  under the wordmark: the mark does that job, and a nine-pixel gloss was competing with the
  name above it for the same glance. Do not put it back as a tagline.
- The mark is the **guilloche rosette seal** in `brand/` — fourteen petals, nested lathe
  curves, generated from parameters and therefore un-redrawable by hand, which is the same
  argument as the credential itself. `ui/engraving/Seal.tsx` generates it; the constants are
  duplicated from `brand/build.mjs` and `apps/pravaah-rn`, so changing one means changing all
  three. `brand/README.md` records the geometry, the three optical cuts and how to verify it.
- The single sentence the whole product answers to: *"We are not building a payments app.
  We are building the thing that lets a person's financial reputation cross a border with
  them — consented, explainable, and owned by the user."*
- Voice: plain English over jargon. The internal explainer document deliberately teaches
  FIP/FIU/AA in three lines rather than assuming them. The site inherits that register —
  explain the mechanism, never hide behind it.

## Evidence on Hand

- `PRAVAAH-EXPLAINED-SIMPLE.md` and `M3-PASSPORT-EXPLAINED-SIMPLE.md` (repo root) — the
  authoritative plain-English product narrative, including the Ravi scenario, the M0–M7
  chain, and the AA explanation.
- **The shipped surfaces are the source of truth for capability copy**, ahead of any document.
  A doc can lag; the code cannot. In particular:
  - `apps/pravaah-rn/src/features/kyc/flow.ts` + `check-labels.ts` — the real per-country
    check sequence and labels. `/how-to-apply` mirrors this and must not drift.
  - `apps/pravaah-rn/src/features/*/​*-meta.ts` — the holder-facing vocabulary for score,
    payments, insurance and security. These files carry the reasoning behind each state's
    wording, and site copy about those states should agree with them rather than re-invent a
    tone.
  - `apps/pravaah-admin/features/routes.ts` — the staff console's own comments explain why
    each review queue exists, which is the evidence for the claim that humans are kept in
    the loop deliberately.
- **Re-runnable checks**, listed on `/what-is-built` with their commands. Every claim of the
  form "this works" on the site should be traceable to one of them. Adding a claim without
  one is the failure mode this section exists to prevent.
- **Absent, must not be fabricated:** testimonials, customer logos, press coverage, user
  numbers, screenshots of the unreleased app, benchmark scores, any certification badge, and
  any figure that cannot be re-derived from the repository by a sceptical reader.

## Product Principles

1. **Trust is the product, so the site's job is proof, not persuasion.** Every claim about
   consent, encryption, or deletion must be traceable to something the system actually does.
2. **Explain the rail, don't hide it.** The Account Aggregator is the hardest and most
   valuable idea here. Teaching it plainly is a differentiator; abstracting it away turns
   MyPravaah back into a generic fintech app.
3. **The user owns the credential.** Any design that reads as "we hold your score and grant
   you access" contradicts the product.
4. **Revocation is the money-shot.** The single most persuasive moment is a person deleting
   their own data instantly. Give it real weight on the surface.
5. **Never overstate the stage — and never understate it either.** The failure mode changed.
   The risk was once claiming unfinished features; it is now the opposite, because everything
   is finished and the copy still said otherwise. Both directions are the same bug: the site
   describing something other than what exists. Read `STAGE`, state both halves, do not
   average them.
6. **A claim needs a check.** If a sentence on the site asserts that something works, there
   should be a command on `/what-is-built` that proves it. This is what makes the honesty
   structural rather than a tone of voice.

## Accessibility & Inclusion

Audience is mobile-first, frequently on mid-range Android over mobile data, and reading
English as a second or third language. Implications treated as requirements: short sentences
over dense paragraphs, no jargon without an inline definition, real text over text-in-image,
comfortable tap targets, and legibility that survives a bright screen outdoors and a dim one
at night. WCAG 2.2 AA contrast is the floor.
