/**
 * What is actually built, in detail.
 *
 * This file exists because two audiences ask the same question in different
 * registers. A holder asks "what can I do with this, and what happens to my
 * data". Someone assessing the work asks "is any of this real". The honest
 * answer to both is the same set of facts, so they are written once here and the
 * page presents them at two levels of depth rather than in two voices.
 *
 * SOURCE for every line: the three shipped surfaces in this repository —
 * `apps/pravaah-rn/src` (holder app), `apps/pravaah-be/src/modules` (API),
 * `apps/pravaah-admin/app/dashboard` (staff console). Nothing here is
 * aspiration written in the present tense, and nothing here is a metric that
 * cannot be re-derived from the repository by someone who doubts it.
 */

/* ────────────────────────────────────────────────────────────────────────────
   The surfaces
   ──────────────────────────────────────────────────────────────────────────── */

export interface Surface {
  name: string;
  role: string;
  /** What a person does here. */
  detail: string;
  /** The parts a visitor would recognise. */
  holds: readonly string[];
}

export const SURFACES: readonly Surface[] = [
  {
    name: "Holder app",
    role: "The person who owns the reputation",
    detail:
      "An Expo app carrying the whole holder journey: verification, the consent screens, the score with its reasons, the receipt wallet, payments, cover, and a security section showing every decision the system has made about you. It is where the copilot's conversation will live.",
    holds: [
      "Verification, step by step",
      "Consent — grant, view, revoke",
      "Score, factors and ranked improvements",
      "Receipt wallet, share history, revoke",
      "Partner requests, approved claim by claim",
      "Wallet, payees, QR, autopay, statement, disputes",
      "Quotes, policies, claims with documents",
      "Registered devices and a security activity log",
    ],
  },
  {
    name: "API",
    role: "Everything the holder app cannot be trusted to decide",
    detail:
      "A NestJS service holding the state machines, the double-entry ledger, the credential issuer, the risk engine and the scheduled jobs. Provider integrations sit behind interfaces, so a sandbox implementation is swapped for a production one without touching business logic.",
    holds: [
      "Identity check orchestration and manual-review queue",
      "Consent lifecycle, encrypted fetch, data-life deletion",
      "Feature normalisation and the scoring model registry",
      "SD-JWT receipt issuance, status list, verification",
      "Partner API — request, verify, record a decision",
      "Ledger, limits, quotes, rail reconciliation",
      "Underwriting, policy lifecycle, claims adjudication",
      "Risk scoring, device trust, case management",
    ],
  },
  {
    name: "Staff console",
    role: "The humans the system deliberately keeps in the loop",
    detail:
      "A Next.js console for the decisions that must not be automated: a name that nearly matches, a payment held for review, a claim that needs a person, a receipt to suspend, a partner to approve. It is where the product's refusal to auto-reject becomes an actual queue with an actual clock.",
    holds: [
      "Identity review queue",
      "Consent audit",
      "Model registry with a fairness gate, and issued-score audit",
      "Receipt oversight, issuer keys, panel partner approval",
      "Ledger reconciliation, stuck payments, disputes",
      "Insurance book, claim queue, policies, products",
      "Fraud case queue, assessments, lists",
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   Measured facts
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Figures, each counted from the repository rather than estimated.
 *
 * Deliberately small in number, and deliberately not the ones a deck would
 * choose. Lines of code is vanity; a passing suite and a schema size say
 * something about whether the state machines exist. Every value here is
 * re-derivable by the reader, and the commands to do it are given, because a
 * number a visitor cannot check is a number they are being asked to trust.
 */
export const BUILD_FACTS: ReadonlyArray<{
  label: string;
  value: string;
  /** How to re-derive it. */
  from: string;
}> = [
  {
    label: "Modules complete",
    value: "8 of 9",
    from: "Identity, consent, score, receipt, payments, insurance, fraud, panel verification. The ninth, the copilot, is in build.",
  },
  {
    label: "Backend tests",
    value: "719 passing",
    from: "30 suites, all green. Run npm test in apps/pravaah-be.",
  },
  {
    label: "Database models",
    value: "70",
    from: "Count the model declarations in prisma/schema.prisma.",
  },
  {
    label: "Market",
    value: "India",
    from: "Decentro for KYC and UPI, Setu for the Account Aggregator — each behind a provider interface.",
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   How it is verified
   ──────────────────────────────────────────────────────────────────────────── */

export interface Evidence {
  title: string;
  body: string;
  /** A command in the repository that re-runs the check. */
  command?: string;
}

/**
 * Evidence, not assurance.
 *
 * Each entry names something re-runnable rather than a number to be believed.
 * A screenshot proves a render; a command that drives the real database and
 * fails loudly proves the mechanism, and can be run by somebody who assumes we
 * are lying.
 */
export const EVIDENCE: readonly Evidence[] = [
  {
    title: "The whole suite passes",
    body: "719 tests across 30 suites, all green. They cover the state machines rather than the rendering: which transitions are legal, what a concurrent settlement does, whether a two-person household sharing a tablet is mistaken for a device farm.",
    command: "apps/pravaah-be $ npm test",
  },
  {
    title: "A receipt is issued, presented, verified and revoked",
    body: "One script drives the full lifecycle against the real database: issue, present with selective disclosure, verify the issuer signature and the holder's proof of possession, then revoke and confirm that verification now fails. Nothing in it is a fixture.",
    command: "apps/pravaah-be $ npm run verify:passport",
  },
  {
    title: "One person checking another leaks nothing early",
    body: "A second script boots the real service and runs the person-to-person handshake end to end — A scans B's receipt card, B approves a subset, A collects. The holder's device keypair is generated inside the script and never leaves it, so the proof of possession is genuine. It pins the properties that make the exchange safe, including that the scan response carries no fact about the holder before approval.",
    command: "apps/pravaah-be $ npx tsx scripts/verify-peer-check.ts",
  },
  {
    title: "The explanation adds up to the score",
    body: "The scoring self-check asserts that the contributions shown under 'why this score' sum exactly to the model's margin — if that drifts, the explanation has stopped being an explanation of the number beside it. It also checks that a parked lump sum cannot out-score a genuine saver, that a thin file produces a visibly wider confidence band, and that the fairness gate actually rejects a biased model instead of passing everything.",
    command: "apps/pravaah-be $ npx tsx scripts/verify-scoring.ts",
  },
  {
    title: "Money is conserved through a claim",
    body: "The insurance self-check proves that collecting a premium, earning it, paying a claim and refunding a premium net to exactly zero across every account — the trial balance follows from that. It also checks that reputation pricing genuinely separates bands, that the waiting period compares the incident date so filing late cannot convert an uncovered incident into a covered one, and that a forged document blocks auto-approval on its own.",
    command: "apps/pravaah-be $ npm run verify:insurance",
  },
  {
    title: "No amount is ever a floating-point number",
    body: "Amounts are integer minor units end to end and exchange rates are scaled integers. A harness feeds every money projection a fixture of big integers and requires the result to survive serialisation, then parses the database schema and fails if a new integer money column has been added without a projection covering it — so the next instance is caught rather than the last one.",
    command: "apps/pravaah-be $ npm run verify:money",
  },
  {
    title: "A caught error cannot poison a payment transaction",
    body: "In Postgres a failed statement aborts the whole transaction, so the common create-then-catch idiom quietly turns one lost race into a permanently stuck transfer — and the resulting state error replaces the real cause in the logs. That pattern is invisible to the type checker, so a dedicated check scans for it.",
    command: "apps/pravaah-be $ npm run verify:tx",
  },
  {
    title: "The risk engine's wiring is asserted, not assumed",
    body: "Payments, insurance, consent and auth depend on the fraud module; it depends on none of them, and their handlers register themselves at boot. A test asserts that the registration actually happened, because the failure mode is otherwise an undefined injection discovered at the moment an analyst releases somebody's money.",
    command: "apps/pravaah-be $ npm test -- fraud.wiring",
  },
  {
    title: "The wallet's crypto is tested outside the app",
    body: "The device signing code carries no Expo imports, deliberately, so it can be driven against Node's own crypto and checked for real signature conformance. Wallet crypto that can only be exercised inside a simulator is wallet crypto nobody has tested.",
    command: "apps/pravaah-rn $ npm run verify:holder-key",
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   Decisions worth defending
   ──────────────────────────────────────────────────────────────────────────── */

export interface Decision {
  /** The choice, stated as a claim. */
  title: string;
  /** Why the obvious alternative is wrong. */
  body: string;
  module: string;
}

/**
 * The engineering choices that carry the product's promises.
 *
 * Selected on one criterion: each is a place where the obvious implementation
 * would have silently broken a promise made elsewhere on this site. A list of
 * clever details would be vanity; these are the load-bearing ones.
 */
export const DECISIONS: readonly Decision[] = [
  {
    module: "M0",
    title: "A near-miss name goes to a person, not to a rejection",
    body: "Names transliterate badly across scripts, and initials, ordering and spelling legitimately vary between a PAN, an Aadhaar record and a bank account. Auto-rejecting a partial mismatch would fail hardest for exactly the population this product exists for, so it routes to a review queue instead — which means the console is part of the product rather than an internal tool.",
  },
  {
    module: "M1",
    title: "Deletion is a scheduled job, not a support promise",
    body: "The retention period is fixed at the moment consent is granted and enforced when it expires. Revocation deletes immediately. Neither depends on anybody remembering, or on us choosing to honour a request.",
  },
  {
    module: "M2",
    title: "A thin file returns 'not enough history', never a number",
    body: "Five distinct non-score states exist because each one leads somewhere different — no consent, not enough data, still computing, expired, failed. Collapsing them into one empty state would strand a person with no next step, and inventing a score from thin data would be the specific harm this product is meant to undo.",
  },
  {
    module: "M2",
    title: "Reasons are bars, not points",
    body: "The model's contributions live in log-odds space, so the absolute figures are meaningless to a person and printing them would invite arithmetic that does not hold. Only the relative size of each driver carries meaning, so only that is shown.",
  },
  {
    module: "M2",
    title: "Protected attributes are a separate, audit-only consent",
    body: "Fairness cannot be measured without knowing who was affected, and holding that data is a risk in itself. So it is a distinct opt-in, used only for bias auditing, and the values are never readable back out — the app can learn which attributes are held, never what they say.",
  },
  {
    module: "M3",
    title: "Every score threshold is minted, true and false alike",
    body: "A receipt that only carried the thresholds a holder passes would leak their band through the number of hidden claims. So all of them are present and the disclosure set is uniform, which is the difference between selective disclosure and selective disclosure that works.",
  },
  {
    module: "M3",
    title: "Withheld claims are shown as withheld",
    body: "A partner who asked for something and did not receive it is told so explicitly, rather than being left to read absence as a negative answer. A holder who declines a claim should not be silently answering 'no' on their own behalf.",
  },
  {
    module: "M3",
    title: "The signature format is the interoperable one, not the convenient one",
    body: "Node's default signature encoding verifies perfectly against our own code and is rejected by every conformant wallet — a bug that would pass every internal test and fail in front of the first real verifier. The issuer emits the standard form, and the trust anchor is served where the identifier says it is, so the receipt is verifiable by parties who have never heard of us.",
  },
  {
    module: "M4",
    title: "Two webhooks cannot pay the same transfer twice",
    body: "Concurrent settlement callbacks both read a pending transaction before either writes, and no application-level status check can arbitrate that. A database constraint on the ledger leg is what actually stops the second credit — the check is not wrong, it is not atomic.",
  },
  {
    module: "M4",
    title: "An unknown rail code means 'unknown', never 'failed'",
    body: "Rails add response codes. Reading one we have never seen as 'nothing happened' would refund senders whose money did in fact move. Unknown classifies as deemed-pending and goes to reconciliation, and a late settlement is a legal correction rather than an impossible state.",
  },
  {
    module: "M4",
    title: "Daily limits are bucketed in Indian time",
    body: "A UTC day rolls over at half past five in the morning in India, which would hand a user two days of transfer limit inside one Indian day. Buckets are computed in IST, and the annual cap follows the Indian financial year rather than the calendar.",
  },
  {
    module: "M5",
    title: "The claim document list does not assume a payslip",
    body: "A daily-wage worker paid in cash has no payslip, and a document list that demands one fails the people this cover is for. Each document type names the alternatives a reviewer will actually accept — an employer letter, a muster-roll entry — because the hint is the load-bearing half.",
  },
  {
    module: "M5",
    title: "A higher price is an answer, not a rejection",
    body: "A substandard rating arrives with its reason and with what would change it, and is styled as an offer rather than a refusal. A decline arrives as a explained outcome rather than an error, because the alternative is the unexplained no this audience already gets everywhere.",
  },
  {
    module: "M6",
    title: "Signals combine so that noise cannot manufacture a block",
    body: "A weighted sum has no ceiling, so five weak circumstantial signals cross a hold threshold; normalise it and a mild extra signal dilutes a severe one, letting an attacker lower their own risk score by adding noise. The combination is multiplicative instead, and the structural rules that matter bypass the arithmetic entirely.",
  },
  {
    module: "M6",
    title: "A hold is a delay, and it never accuses",
    body: "At these thresholds false positives are the expected case, which is the whole reason a held action is a delay rather than a decline. So the copy says 'under review', never 'flagged as suspicious', and it never names the detector that fired — an explanation is useful to a legitimate user, and a specification is useful to an attacker.",
  },
  {
    module: "M6",
    title: "Identifiers in the risk graph are keyed, not hashed",
    body: "A payment address or a ten-digit mobile number is brute-forceable in minutes, so a plain hash would be decorative for exactly the identifiers that matter. The graph is keyed with a secret, and refuses to start without one rather than falling back to a default that would make every deployment's values precomputable.",
  },
  {
    module: "M7",
    title: "A scan learns nothing until the holder approves",
    body: "Scanning a receipt code returns a request identifier and the claims being asked for — and nothing at all about the holder, not even confirmation that the code belonged to anyone. An unrecognised code returns the same answer as a non-MyPravaah one, so the code space cannot be walked to discover which receipts exist.",
  },
  {
    module: "M7",
    title: "A person asking is not allowed to name themselves",
    body: "When one person checks another's receipt, the requester's name comes from their own verified identity or is absent. A self-declared display name on a consent screen would be a free impersonation tool: 'approve — asked by someone you trust'.",
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   Refusals
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Things the product does not do, and will not.
 *
 * Kept separate from the gaps on /security, which are about what has not been
 * earned yet. These are permanent — a refusal is a design commitment, and
 * stating it is the only way a visitor can hold us to it.
 */
export const REFUSALS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "We do not lend, and we do not underwrite",
    body: "Banks, NBFCs and insurers on the panel carry the capital and the risk, and they make the decision. What MyPravaah adds is the evidence behind it and the reasons in front of you. A product that blurred that line would be claiming a licence it does not hold.",
  },
  {
    title: "No approval, limit or price written by a language model",
    body: "The copilot being built chooses which tool to call and explains what came back. Approvals and limits come from the scoring model and the partner's own rules, and prices from the pricing engine — each deterministic, and each score recorded with the model version that produced it. The copilot can only render what those returned, so it has no approval of its own to hallucinate.",
  },
  {
    title: "No bank credentials, ever, as a fallback or otherwise",
    body: "There is no field for a bank password anywhere in the product, and screen-scraping is not an implementation that exists to be switched on when the aggregator rail is unavailable. Anyone asking you for banking credentials on our behalf is not us.",
  },
  {
    title: "No directory institutions can query behind your back",
    body: "We do not operate a lookup where a lender types your name and receives your standing. Every disclosure begins with a request you see and ends with claims you ticked.",
  },
  {
    title: "No selling, sharing or advertising on your financial data",
    body: "Data obtained for one stated purpose is usable only for that purpose. A consent for a credit assessment does not become a licence to build a profile, and there is no second business model here that would need one.",
  },
  {
    title: "No score without the reasons",
    body: "There is no path in the product that shows a number on its own. If the reasons cannot be produced, the score is not served.",
  },
  {
    title: "No app PIN that could be mistaken for a bank PIN",
    body: "The UPI PIN is entered in the bank's own secure component and never reaches MyPravaah. Where the app asks for its own PIN it says so explicitly, because a screen asking for 'your PIN' during a payment is indistinguishable from a phishing screen.",
  },
  {
    title: "No simulated rail in production",
    body: "The payment simulator refuses to start when the environment is production, and a missing provider credential throws rather than silently falling back to it. A silent downgrade would leave an operator believing they had tested the real rail.",
  },
];
