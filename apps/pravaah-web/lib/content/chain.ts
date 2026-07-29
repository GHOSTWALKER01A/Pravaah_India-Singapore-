/**
 * The chain of trust. Each link is impossible without the one before it —
 * which is why these are numbered and why the numbering is not decoration.
 *
 * SOURCE: PRAVAAH-EXPLAINED-SIMPLE.md §8, plus the shipped surfaces themselves —
 * `apps/pravaah-rn/src` (holder app), `apps/pravaah-be/src/modules` (API) and
 * `apps/pravaah-admin/app/dashboard` (staff console). Every `detail` here
 * describes behaviour that exists in one of those three.
 *
 * `status` is not marketing language. All eight modules are built and verified
 * end-to-end; what is NOT live is the regulated rail behind some of them and
 * the public app release. That distinction is stated once, prominently, in
 * `STAGE` (lib/config/site.ts) and again per-module through `rail` — it is
 * never blurred by calling a sandbox integration "live".
 */

export type ModuleStatus = "built" | "roadmap";

/**
 * Whether the module's external dependency is the real thing.
 *
 * `none` — the module depends on no third party; what runs is what ships.
 * `sandbox` — the provider integration is complete and runs against the
 *   provider's test environment, pending a licence, a PSP agreement or
 *   production credentials.
 */
export type RailStatus = "none" | "sandbox";

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
      "Four to seven steps depending on your corridor, in one sitting, from your phone. No document is scanned, notarised or attested.",
    status: "built",
    rail: "sandbox",
    caveat:
      "PAN, Aadhaar, penny-drop and Singpass run against provider sandboxes until production credentials are issued.",
  },
  {
    id: "M1",
    name: "Consent & data",
    claim: "You agreed to share exactly this.",
    detail:
      "Your financial history is requested through India's regulated Account Aggregator rail — a named scope, for a named purpose, for a named period, with a named retention window. You approve it on the aggregator's own screen. Approval produces a signed consent artefact. The data arrives encrypted, is normalised into features, and is deleted when the agreed data-life expires or the moment you revoke.",
    holder:
      "One screen listing what is being asked for and for how long. Approve, refuse, or revoke later — revocation deletes immediately.",
    status: "built",
    rail: "sandbox",
    caveat:
      "MyPravaah is not yet a licensed Financial Information User, so the aggregator integration runs in sandbox.",
  },
  {
    id: "M2",
    name: "Score",
    claim: "Here is your standing, and here is why.",
    detail:
      "The normalised history becomes a score on a 300–900 scale with a confidence interval, a coverage figure, and the reasons attached. Each driver is named in plain language and shown as a relative bar rather than a points figure, because the model's contributions are log-odds and printing them would invite arithmetic that does not hold. Alongside the reasons sit ranked improvements with the gain each one is worth, re-computed rather than guessed.",
    holder:
      "A number, the band it sits in, the five things moving it, and the specific changes that would raise it. Thin data returns 'not enough history yet' instead of an invented number.",
    status: "built",
    rail: "none",
  },
  {
    id: "M3",
    name: "Passport",
    claim: "You hold it, not us.",
    detail:
      "The score is sealed into an SD-JWT verifiable credential signed by the issuer and bound to a key generated on your device. Selective disclosure is per-claim: you choose what a given verifier sees, and what you withhold is shown to them as withheld rather than inferred as false. There is a physical card too — MRZ, NFC payload and a verify URL — for a counter that has no app.",
    holder:
      "A credential in your wallet, a share history of who saw which claims, and a revoke button that kills it. Reinstalling the app is detected and offers re-issue rather than failing at a counter.",
    status: "built",
    rail: "none",
  },
  {
    id: "M7",
    name: "Verification",
    claim: "A stranger can check it is real.",
    detail:
      "A verifier checks the issuer's signature, the holder's proof of possession, the revocation status list and a single-use nonce — the way a border officer verifies a stamp, without calling us. Two paths exist: a registered institution's request arrives in your wallet for approval, and a person can scan your code and get back only the claims you tick.",
    holder:
      "You approve or decline every request, claim by claim, and you can see afterwards exactly what left your wallet.",
    status: "built",
    rail: "none",
    caveat:
      "Institutions are registered by us in the staff console. A self-serve partner portal is not built.",
  },
];

/** Downstream of the passport. Genuinely useful, genuinely not the point. */
export const DOWNSTREAM: readonly ChainLink[] = [
  {
    id: "M4",
    name: "Money movement",
    claim: "Send across the corridor.",
    detail:
      "UPI within India and the UPI–PayNow link to Singapore, on a double-entry ledger where every transfer books balanced legs and the trial balance is checked to zero. Quotes are priced intents, frozen and single-use, so the rate you confirmed is the rate that settles. A payment the rail reports late still reconciles correctly rather than being refunded twice.",
    holder:
      "A wallet, payees, QR, autopay mandates, a statement showing ledger lines rather than a tidied summary, and a disputes flow.",
    status: "built",
    rail: "sandbox",
    caveat:
      "UPI–PayNow is a bank rail reached through a regulated PSP. Domestic and cross-border transfers run on a scripted simulator until those agreements exist; the simulator is refused outright in production.",
  },
  {
    id: "M5",
    name: "Insurance",
    claim: "Priced on evidence, not on ignorance.",
    detail:
      "Income protection, health top-up and travel accident cover, underwritten against the same consented data. A higher rate arrives with the reason and with what would change it; a decline arrives as an answer rather than an error. Claims carry documents, a review thread, and a payout into the wallet.",
    holder:
      "A quote you can read, a policy certificate, and a claim you can file from your phone with photographs of what you have — not a document list that assumes salaried employment.",
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

/** Everything, in build order, for pages that need one list. */
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
