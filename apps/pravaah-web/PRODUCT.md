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

Pravaah lets a person carry their financial reputation across a border.

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
own database and rent access to it. Pravaah issues a signed, tamper-evident credential to
the person, who can present it to any institution in any country — and who can revoke the
underlying data at any moment, after which it is deleted.

The second uncopyable fact: the data is obtained through India's regulated **Account
Aggregator** rail. Pravaah never asks for a bank password, never screen-scrapes, and never
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

**Consent & data (M1)** — three roles: FIP (the bank, which holds the data), FIU (Pravaah,
which wants it), AA (the licensed consent broker in between). Pravaah requests a named data
scope, for a named purpose, over a named time window, with a named retention period. The
user approves or rejects on the aggregator's own screen. An active consent produces a signed
consent artefact. Data is encrypted bank-to-Pravaah, decrypted server-side, and normalised
into features. It is auto-deleted when the agreed data-life expires, and deleted immediately
on revocation.

**Score, passport, verification (M2/M3/M7)** — built in order; each step is impossible
without the one before it. Chain of trust, not a feature list.

Related surfaces already in the repo: `apps/pravaah-rn` (Expo user app — KYC and consent
flows, deep-link scheme `parvaahrn`, bundle id `com.pravaah.app`), `apps/pravaah-admin`
(Next.js staff console for KYC review), `apps/pravaah-be` (NestJS API).

## Capabilities and Constraints

**Confirmed and shippable today (M0, M1).** Identity verification on both corridors, consent
lifecycle including revocation, encrypted data fetch, normalisation, purpose limitation, and
data-life deletion — verified end-to-end.

**Built but not yet public.** M2 (score), M3 (passport credential), M4 (UPI ↔ PayNow),
M5 (insurance), M6 (fraud), M7 (partner console) are ahead. The site must not present them
as available. Describing them as the roadmap is honest; implying a visitor can use them
today is not.

**The mobile app is not published.** There is no App Store or Play Store listing yet. Every
app-download surface must be an explicitly labelled pre-launch state. Store URLs are
env-driven and empty; the deep-link plumbing (`parvaahrn://`) is built and dormant.

**Provider abstraction.** Decentro (India KYC), Singpass (Singapore identity), and the AA
provider all sit behind interfaces; sandbox implementations are swapped for live ones without
touching business logic. This is an internal engineering fact, not a visitor-facing claim.

**Undecided / must not be invented.** Registered legal entity name and address, grievance
officer and DPO contact, RBI or MAS licence status, security certifications (SOC 2, ISO
27001), launch date, pricing, user counts, and partner names. These ship as clearly marked
placeholders on the user's replacement list.

## Brand Commitments

- Name: **Pravaah** (Sanskrit — flow). The mobile app currently ships under the slug
  `parvaah-rn`; the public-facing spelling is *Pravaah*.
- The single sentence the whole product answers to: *"We are not building a payments app.
  We are building the thing that lets a person's financial reputation cross a border with
  them — consented, explainable, and owned by the user."*
- Voice: plain English over jargon. The internal explainer document deliberately teaches
  FIP/FIU/AA in three lines rather than assuming them. The site inherits that register —
  explain the mechanism, never hide behind it.
- Existing colour signal from the app: `#208AEF` splash, blue primary in the admin console.
  Recorded as a fact about sibling surfaces, not as a binding constraint on this one.

## Evidence on Hand

- `PRAVAAH-EXPLAINED-SIMPLE.md` (repo root) — the authoritative plain-English product
  narrative, including the Ravi scenario, the M0–M7 chain, and the AA explanation. All
  factual copy on this site derives from it.
- `apps/pravaah-rn/src/features/kyc/flow.ts` and `check-labels.ts` — the real, per-country
  required-check sequence and its human labels. The "steps to apply" page must match this
  exactly rather than invent a generic KYC list.
- **Absent, must not be fabricated:** testimonials, customer logos, press coverage, user
  numbers, screenshots of the unreleased app, benchmark scores, and any certification badge.

## Product Principles

1. **Trust is the product, so the site's job is proof, not persuasion.** Every claim about
   consent, encryption, or deletion must be traceable to something the system actually does.
2. **Explain the rail, don't hide it.** The Account Aggregator is the hardest and most
   valuable idea here. Teaching it plainly is a differentiator; abstracting it away turns
   Pravaah back into a generic fintech app.
3. **The user owns the credential.** Any design that reads as "we hold your score and grant
   you access" contradicts the product.
4. **Revocation is the money-shot.** The single most persuasive moment is a person deleting
   their own data instantly. Give it real weight on the surface.
5. **Never overstate the stage.** Two of eight modules are live and the app is unpublished.
   Honesty about that is itself trust-building for this audience.

## Accessibility & Inclusion

Audience is mobile-first, frequently on mid-range Android over mobile data, and reading
English as a second or third language. Implications treated as requirements: short sentences
over dense paragraphs, no jargon without an inline definition, real text over text-in-image,
comfortable tap targets, and legibility that survives a bright screen outdoors and a dim one
at night. WCAG 2.2 AA contrast is the floor.
