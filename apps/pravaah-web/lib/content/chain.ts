/**
 * The chain of trust. Each link is impossible without the one before it —
 * which is why these are numbered and why the numbering is not decoration.
 *
 * SOURCE: PRAVAAH-EXPLAINED-SIMPLE.md §8, plus the shipped surfaces themselves —
 * `apps/pravaah-rn/src` (holder app), `apps/pravaah-be/src/modules` (API) and
 * `apps/pravaah-admin/app/dashboard` (staff console). Every `detail` on a
 * `built` row describes behaviour that exists in one of those three.
 *
 * Vocabulary follows the Paytm build bible: the "passport" is the reputation
 * receipt, a "verifier" is a panel partner (a bank, NBFC or insurer). The code
 * keeps its old identifiers — `passport` module, `verify:passport` script —
 * and so do the commands quoted on /what-is-built, because those are real.
 *
 * `status` is not marketing language. Eight modules are built and verified
 * end-to-end; what is NOT live is the regulated rail behind some of them and
 * the public app release. The copilot and its two thin layers are `building`
 * and are written in the future tense. That distinction is stated once,
 * prominently, in `STAGE` (lib/config/site.ts) and again per-row through
 * `status` and `rail` — it is never blurred by calling a sandbox integration
 * "live" or an unbuilt layer "done".
 */

export type ModuleStatus = "built" | "building" | "roadmap";

/**
 * Whether the module's external dependency is the real thing.
 *
 * `none` — the module depends on no regulated third party; what runs is what
 *   ships.
 * `sandbox` — the provider integration is complete and runs against the
 *   provider's test environment, pending a licence, a PSP agreement or
 *   production credentials.
 * `synthetic` — the module runs on seeded data standing in for a source we do
 *   not have access to. Stated so the demo is honest about which it ran on.
 */
export type RailStatus = "none" | "sandbox" | "synthetic";

export interface ChainLink {
  id: string;
  name: string;
  /** What it establishes, in the fewest true words. */
  claim: string;
  /** How it establishes it. */
  detail: string;
  /** What the holder actually does or sees. Written for a first-time reader. */
  holder: string;
  status: ModuleStatus;
  rail: RailStatus;
  /** The limit worth knowing before trusting the row above it. */
  caveat?: string;
}

export const CHAIN: readonly ChainLink[] = [
  {
    id: "M0",
    name: "Identity",
    claim: "This is really you.",
    detail:
      "PAN, Aadhaar via DigiLocker, a bank penny-drop, a live selfie, a face match against the document photo, and a sanctions/PEP screen. Every required check must clear before anything else runs, and the flow will not move past a check that has not. A name that nearly matches goes to a human reviewer, not to a rejection.",
    holder:
      "Six steps, in one sitting, from your phone. No document is scanned, notarised or attested.",
    status: "built",
    rail: "sandbox",
    caveat:
      "PAN, Aadhaar and penny-drop run against Decentro's sandbox until production credentials are issued.",
  },
  {
    id: "M1",
    name: "Consent & data",
    claim: "You agreed to share exactly this.",
    detail:
      "Your financial history is requested through India's regulated Account Aggregator rail — a named scope, for a named purpose, for a named period, with a named retention window. You approve it on the aggregator's own screen. Approval produces a signed consent artefact. The data arrives encrypted, is normalised into features, and is deleted when the agreed data-life expires or the moment you revoke. One consent replaces the five forms and the document chase.",
    holder:
      "One screen listing what is being asked for and for how long. Approve, refuse, or revoke later — revocation deletes immediately.",
    status: "built",
    rail: "sandbox",
    caveat:
      "MyPravaah is not yet a licensed Financial Information User, so the aggregator integration (Setu, behind a provider interface) runs in sandbox.",
  },
  {
    id: "M2",
    name: "Score",
    claim: "Here is your standing, and here is why.",
    detail:
      "The normalised history becomes a score on a 300–900 scale with a confidence interval, a coverage figure, and the reasons attached. The reasons are the model's own attributions — exact Shapley values — ranked by size, so nothing is cited that the model did not use. Each is named in plain language and shown as a relative bar rather than a points figure. Alongside the reasons sit ranked improvements with the gain each one is worth, re-computed rather than guessed. A fairness audit runs against every model before it can serve a score.",
    holder:
      "A number, the band it sits in, the five things moving it, and the specific change that would raise it most. Thin data returns 'not enough history yet' instead of an invented number.",
    status: "built",
    rail: "none",
  },
  {
    id: "M3",
    name: "Reputation receipt",
    claim: "You hold it, not us.",
    detail:
      "The score is sealed into an SD-JWT verifiable credential signed by the issuer and bound to a key generated on your device. Selective disclosure is per-claim: you choose what a given partner sees, and what you withhold is shown to them as withheld rather than inferred as false. It expires, and you can revoke it. There is a printed card too — machine-readable zone, NFC payload and a verify URL — for a desk that has no integration.",
    holder:
      "A receipt in your wallet, a share history of who saw which claims, and a revoke button that kills it. A rejection at one lender becomes a re-application at the next without redoing any of the above.",
    status: "built",
    rail: "none",
  },
  {
    id: "M7",
    name: "Panel verification",
    claim: "A lender can check it is real.",
    detail:
      "A panel partner — a bank, an NBFC or an insurer — checks the issuer's signature, the holder's proof of possession, the revocation status list and a single-use nonce, without calling us. The partner's request arrives in your wallet for approval; once you share, the partner records its decision against the receipt — approved, declined, or referred to a person. A person can also scan your code and get back only the claims you tick.",
    holder:
      "You approve or decline every request, claim by claim, and you can see afterwards exactly what left your wallet and what the partner decided.",
    status: "built",
    rail: "none",
    caveat:
      "The partner API is built — request, verify, record a decision. The web view a loan officer would use is in build, and partners are approved by us in the staff console.",
  },
];

/** Downstream of the receipt. Genuinely useful, genuinely not the point. */
export const DOWNSTREAM: readonly ChainLink[] = [
  {
    id: "M4",
    name: "Payments",
    claim: "Money that moves, on UPI.",
    detail:
      "Domestic UPI on a double-entry ledger where every transfer books balanced legs and the trial balance is checked to zero. Quotes are frozen, single-use priced intents, so the fee you confirmed is the fee that settles. A payment the rail reports late still reconciles correctly rather than being refunded twice, and a transfer retried after a timeout cannot run twice.",
    holder:
      "A wallet, payees, QR, autopay mandates, a statement showing ledger lines rather than a tidied summary, and a disputes flow.",
    status: "built",
    rail: "sandbox",
    caveat:
      "UPI runs against Decentro's sandbox, or a scripted simulator that refuses to start in production. No real money has moved.",
  },
  {
    id: "M5",
    name: "Insurance",
    claim: "Priced on evidence, not on ignorance.",
    detail:
      "Small-ticket cover — income protection and a health top-up — underwritten against the same consented data. A higher rate arrives with the reason and with what would change it; a decline arrives as an answer rather than an error. Claims carry documents, a review thread, and a payout into the wallet.",
    holder:
      "A quote you can read in one sentence and decline in one tap, a policy certificate, and a claim you can file from your phone with photographs of what you have — not a document list that assumes a payslip.",
    status: "built",
    rail: "sandbox",
    caveat:
      "Cover is priced and administered end-to-end, but no risk carrier is on paper yet, so no policy is legally in force.",
  },
  {
    id: "M6",
    name: "Fraud & security",
    claim: "Runs underneath all of it.",
    detail:
      "Device binding, SIM-swap detection, velocity limits, a shared-artefact graph that catches identity farming, and step-up challenges — layered under every other module rather than sitting beside them. Signals combine by noisy-OR so five weak ones cannot manufacture a block and one severe one cannot be diluted. A held payment goes to a human with a clock running against it, not to a decline.",
    holder:
      "Your registered devices, a plain-language record of every security decision made about you — including the ones that let you through — and a way back when a replaced SIM freezes a device.",
    status: "built",
    rail: "sandbox",
    caveat:
      "The telecom SIM-reissue lookup runs against a development provider until a telco agreement is in place.",
  },
];

/**
 * What is being added for the Paytm build. None of it is finished, and every
 * line is written in the future tense for that reason.
 *
 * The copilot is the ninth module. The other two are thin layers rather than
 * modules: one feeds M2 a second source of features, the other sits between
 * M2 and M7 and picks which partners to ask.
 */
export const IN_BUILD: readonly ChainLink[] = [
  {
    id: "M8",
    name: "AI copilot",
    claim: "One conversation instead of five screens.",
    detail:
      "A language-model agent will run the journey as a sequence of tool calls, in Hindi or English, by voice or chat: take the request in the person's own words, ask what it needs, fire the consent, call the scorer and the panel, and turn the model's attributions into sentences. The tools it calls are the endpoints listed under each module above. It chooses the order and explains the result — it never decides approval, limit or price.",
    holder:
      "Say what you need — 'tyohaar ke liye 40,000 chahiye, teen mahine ke liye' — and get back an answer with its reasons, with a transcript beside every voice turn.",
    status: "building",
    rail: "none",
    caveat:
      "Not built yet. Until it ships, every built step runs as an ordinary app screen.",
  },
  {
    id: "SIG",
    name: "Paytm-context signals",
    claim: "The record a bureau cannot see.",
    detail:
      "UPI and merchant cash-flow — inflows, outflows, counterparties, months active, volatility — joined to the Account Aggregator features before scoring, behind a provider interface like every other rail. A bureau sees nothing for a thin-file merchant; eleven months of daily settlements says a great deal.",
    holder:
      "Nothing extra to do. The signals are used only with your consent and only for the purpose stated when you gave it.",
    status: "building",
    rail: "synthetic",
    caveat:
      "Will run on seeded synthetic transactions, and every score will record which source it ran on. No live Paytm data is used.",
  },
  {
    id: "PNL",
    name: "Panel matching",
    claim: "The right partner, not just any partner.",
    detail:
      "A rules table mapping an applicant to the lenders or insurers whose published eligibility they meet, with each partner's indicative terms. Deliberately rules rather than a model: a partner can read why it was or was not asked.",
    holder:
      "Two or three partners, each with its indicative terms and one line on how it differs from the others.",
    status: "building",
    rail: "none",
    caveat: "A learned matcher is roadmap, and will be called that until it exists.",
  },
];

/** Everything built, in build order, for pages that need one list. */
export const ALL_MODULES: readonly ChainLink[] = [
  CHAIN[0],
  CHAIN[1],
  CHAIN[2],
  CHAIN[3],
  DOWNSTREAM[0],
  DOWNSTREAM[1],
  DOWNSTREAM[2],
  CHAIN[4],
];

/** The three words that make the Account Aggregator rail intelligible. */
export const AA_ROLES: ReadonlyArray<{
  abbr: string;
  expands: string;
  is: string;
  here: string;
}> = [
  {
    abbr: "FIP",
    expands: "Financial Information Provider",
    is: "The one that holds the data.",
    here: "Your bank.",
  },
  {
    abbr: "FIU",
    expands: "Financial Information User",
    is: "The one that wants the data.",
    here: "MyPravaah.",
  },
  {
    abbr: "AA",
    expands: "Account Aggregator",
    is: "The licensed broker in the middle.",
    here: "It carries a sealed envelope it cannot open.",
  },
];

/** The consent lifecycle, as the system actually runs it. */
export const CONSENT_STEPS: ReadonlyArray<{ step: string; body: string }> = [
  {
    step: "We ask",
    body: "A request naming the data, the purpose, the period it covers and how long we may keep it.",
  },
  {
    step: "You decide",
    body: "The aggregator shows you that request in plain language, on its screen, not ours. You approve or you refuse.",
  },
  {
    step: "It becomes active",
    body: "Approval produces a signed consent artefact — proof, independent of us, that you agreed to exactly this.",
  },
  {
    step: "Data moves sealed",
    body: "Your bank encrypts the data and sends it through the aggregator to us. The aggregator carries it; it cannot read it.",
  },
  {
    step: "It expires on its own",
    body: "When the agreed data-life ends, it is deleted automatically. Nobody has to remember to do it.",
  },
  {
    step: "Or you end it early",
    body: "Revoke, and it is deleted immediately. That is the whole point of the design.",
  },
];
