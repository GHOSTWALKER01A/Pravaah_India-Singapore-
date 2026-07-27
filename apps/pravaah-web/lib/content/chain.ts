/**
 * The chain of trust. Each link is impossible without the one before it —
 * which is why these are numbered and why the numbering is not decoration.
 *
 * SOURCE: PRAVAAH-EXPLAINED-SIMPLE.md §8. `status` is not marketing language:
 * PRODUCT.md records M0 and M1 as verified end-to-end and everything else as
 * roadmap. The site must never present a roadmap module as available.
 */

export type ModuleStatus = "live" | "roadmap";

export interface ChainLink {
  id: string;
  name: string;
  /** What it establishes, in the fewest true words. */
  claim: string;
  /** How it establishes it. */
  detail: string;
  status: ModuleStatus;
}

export const CHAIN: readonly ChainLink[] = [
  {
    id: "M0",
    name: "Identity",
    claim: "This is really you.",
    detail:
      "PAN, Aadhaar via DigiLocker, a bank penny-drop, a live selfie and a watchlist screen. Every required check must clear before anything else runs. A name that nearly matches goes to a human, not to a rejection.",
    status: "live",
  },
  {
    id: "M1",
    name: "Consent & data",
    claim: "You agreed to share exactly this.",
    detail:
      "Your financial history is requested through India's regulated Account Aggregator rail — a named scope, for a named purpose, for a named period. You approve it on the aggregator's own screen. We never see a password.",
    status: "live",
  },
  {
    id: "M2",
    name: "Score",
    claim: "Here is your standing, and here is why.",
    detail:
      "The raw history is normalised into features — income steadiness, average balance, obligation history — and turned into a score that arrives with its reasons attached, not as an unexplained number.",
    status: "roadmap",
  },
  {
    id: "M3",
    name: "Passport",
    claim: "You hold it, not us.",
    detail:
      "The score is sealed into a signed, tamper-evident credential issued to you. You present it. You can show it to anyone, in any country, without asking our permission.",
    status: "roadmap",
  },
  {
    id: "M7",
    name: "Verification",
    claim: "A stranger can check it is real.",
    detail:
      "A lender, landlord or insurer verifies the signature on your passport the way a border officer verifies a stamp — without calling us, and without you handing over the underlying data.",
    status: "roadmap",
  },
];

/** Downstream of the passport. Genuinely useful, genuinely not the point. */
export const DOWNSTREAM: readonly ChainLink[] = [
  {
    id: "M4",
    name: "Money movement",
    claim: "Send across the corridor.",
    detail:
      "UPI ↔ PayNow. One module of eight, and only worth anything because of the trust built above it.",
    status: "roadmap",
  },
  {
    id: "M5",
    name: "Insurance",
    claim: "Priced on evidence, not on ignorance.",
    detail:
      "The same consented data supports a real quote instead of the newcomer premium.",
    status: "roadmap",
  },
  {
    id: "M6",
    name: "Fraud & security",
    claim: "Runs underneath all of it.",
    detail:
      "Identity-farming, SIM-swap and synthetic-identity defences guard every other module rather than sitting beside them.",
    status: "roadmap",
  },
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
    here: "Pravaah.",
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
