import { z } from 'zod'

/**
 * The claim catalogue — THE contract of the Financial Reputation Passport.
 *
 * Every claim a credential can carry is declared here once, with the metadata
 * three different consumers need:
 *
 *  - the ISSUER decides which claims to mint and which are selectively
 *    disclosable (`alwaysVisible`),
 *  - the WALLET renders the consent-to-disclose screen from `label` +
 *    `sensitivity` + `whyAsked`, so the user reads a sentence rather than a
 *    snake_case key,
 *  - the VERIFIER builds a request from a template and is refused any claim not
 *    in this list.
 *
 * Keeping it in the shared package (not the backend) is deliberate: a wallet that
 * renders a claim the issuer never mints, or a verifier that asks for a claim the
 * wallet cannot explain, is exactly the drift selective disclosure cannot afford.
 */

// ── the claim keys ──────────────────────────────────────────────────────────
/**
 * Claims that travel in the SD-JWT payload IN THE CLEAR. They are visible to
 * anyone the credential is shown to, so this list contains only facts that carry
 * no personal information:
 *
 *  - what kind of document this is, and who issued it (the trust anchor),
 *  - its document number (needed to revoke and to audit a presentation),
 *  - the score SCALE — the legend without which "GOOD" is an uninterpretable
 *    word to a foreign lender. It describes the model, never the holder.
 */
export const ALWAYS_VISIBLE_CLAIMS = [
  'document_type',
  'issuing_authority',
  'credential_number',
  'score_scale',
] as const

export type AlwaysVisibleClaim = (typeof ALWAYS_VISIBLE_CLAIMS)[number]

/**
 * Selectively disclosable claims. The SD-JWT carries only a salted SHA-256
 * digest of each; the holder chooses which cleartext disclosures to send.
 *
 * Order is not significant to the protocol, but it IS the order the wallet
 * renders, so it is grouped the way a person reads: who I am, then how I score,
 * then where that score came from.
 */
export const DISCLOSABLE_CLAIMS = [
  // ── identity (ICAO 9303 visual-zone equivalents) ──
  'given_name',
  'family_name',
  'birth_date',
  'sex',
  'nationality',
  /** The real-passport binding — the anchor every country already trusts. */
  'passport_number',
  /** Pravaah's own public identifier, for support and dispute resolution. */
  'pravaah_id',

  // ── reputation (what a passport does not have, but ours must) ──
  'score_value',
  'score_band',
  /**
   * Threshold assertions. A domestic micro-loan needs "GOOD or better" and
   * nothing else, and these let the holder prove exactly that without revealing
   * the number OR the band.
   *
   * The issuer mints ALL FOUR on every credential, true or false. Minting only
   * the true ones would make the COUNT of `_sd` digests leak the band — the
   * digests are opaque, but there would be a different number of them for an
   * EXCELLENT holder than for a FAIR one. A fixed-size digest array is what
   * keeps an undisclosed claim genuinely invisible.
   */
  'score_at_least_fair',
  'score_at_least_good',
  'score_at_least_very_good',
  'score_at_least_excellent',
  'confidence',
  'coverage',
  'score_as_of',

  // ── provenance (so a verifier can decide HOW MUCH to trust the number) ──
  'model_version',
  'data_rails',
  'consent_ref',
  'kyc_level',
] as const

export type DisclosableClaim = (typeof DISCLOSABLE_CLAIMS)[number]

export type PassportClaim = AlwaysVisibleClaim | DisclosableClaim

export const DisclosableClaimSchema = z.enum(DISCLOSABLE_CLAIMS)

/** How exposing a claim feels to the person it describes. Drives wallet emphasis. */
export const CLAIM_SENSITIVITY = {
  /** Reveals nothing a stranger could misuse. */
  LOW: 'LOW',
  /** Personally identifying, but routinely shared (a name, a nationality). */
  MEDIUM: 'MEDIUM',
  /** Identity-theft grade, or a precise financial figure. Warn before sharing. */
  HIGH: 'HIGH',
} as const

export type ClaimSensitivity =
  (typeof CLAIM_SENSITIVITY)[keyof typeof CLAIM_SENSITIVITY]

export interface ClaimDescriptor {
  claim: DisclosableClaim
  /** Wallet-facing label. Sentence case, no jargon. */
  label: string
  /** What the holder is actually handing over, in one plain line. */
  detail: string
  category: 'identity' | 'reputation' | 'provenance'
  sensitivity: ClaimSensitivity
  /** Why a legitimate verifier would ask — the answer to "should I tick this?". */
  whyAsked: string
}

/**
 * The catalogue. Written for the person tapping "share", not for the engineer
 * reading the schema: every `detail` states the consequence of disclosure, and
 * `whyAsked` gives the holder a way to judge whether a request is reasonable.
 */
export const CLAIM_CATALOGUE: Readonly<
  Record<DisclosableClaim, ClaimDescriptor>
> = {
  given_name: {
    claim: 'given_name',
    label: 'First name',
    detail: 'Your given name, exactly as it was verified during onboarding.',
    category: 'identity',
    sensitivity: 'MEDIUM',
    whyAsked: 'To match you to an application or a tenancy agreement.',
  },
  family_name: {
    claim: 'family_name',
    label: 'Last name',
    detail: 'Your family name, exactly as it was verified during onboarding.',
    category: 'identity',
    sensitivity: 'MEDIUM',
    whyAsked: 'To match you to an application or a tenancy agreement.',
  },
  birth_date: {
    claim: 'birth_date',
    label: 'Date of birth',
    detail: 'Your full date of birth.',
    category: 'identity',
    sensitivity: 'HIGH',
    whyAsked:
      'Usually only needed where the law requires an age check. A lender that already has your score rarely needs this.',
  },
  sex: {
    claim: 'sex',
    label: 'Sex',
    detail: 'The sex recorded on your identity document.',
    category: 'identity',
    sensitivity: 'HIGH',
    whyAsked:
      'Almost never necessary. Think twice: this is never used to compute your score.',
  },
  nationality: {
    claim: 'nationality',
    label: 'Nationality',
    detail: 'Your nationality as a two-letter country code.',
    category: 'identity',
    sensitivity: 'MEDIUM',
    whyAsked:
      'Cross-border lenders and landlords need it for their own residency and sanctions checks.',
  },
  passport_number: {
    claim: 'passport_number',
    label: 'Passport number',
    detail:
      'Your passport number, masked to the last four characters, tying this credential to the document you already travel on.',
    category: 'identity',
    sensitivity: 'HIGH',
    whyAsked:
      'Only for genuinely cross-border use — a foreign landlord or lender linking your reputation to the ID they already trust.',
  },
  pravaah_id: {
    claim: 'pravaah_id',
    label: 'Pravaah ID',
    detail: 'Your permanent public Pravaah identifier.',
    category: 'identity',
    sensitivity: 'LOW',
    whyAsked: 'So the verifier can reference this check in a support query.',
  },

  score_value: {
    claim: 'score_value',
    label: 'Exact score',
    detail: 'Your precise reputation score on the 300–900 scale.',
    category: 'reputation',
    sensitivity: 'HIGH',
    whyAsked:
      'Lenders that price by risk want the number. If they only need a yes/no, share a threshold instead.',
  },
  score_band: {
    claim: 'score_band',
    label: 'Score band',
    detail:
      'Your band — Poor, Fair, Good, Very good or Excellent — without the exact number.',
    category: 'reputation',
    sensitivity: 'MEDIUM',
    whyAsked: 'Enough for most credit decisions, and it reveals far less.',
  },
  score_at_least_fair: {
    claim: 'score_at_least_fair',
    label: 'Fair or better',
    detail: 'Proves only whether you are Fair or better. Nothing else.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked: 'A minimum-eligibility gate.',
  },
  score_at_least_good: {
    claim: 'score_at_least_good',
    label: 'Good or better',
    detail: 'Proves only whether you are Good or better. Nothing else.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked:
      'The usual bar for a small loan or a rental. The least you can share and still qualify.',
  },
  score_at_least_very_good: {
    claim: 'score_at_least_very_good',
    label: 'Very good or better',
    detail: 'Proves only whether you are Very good or better. Nothing else.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked: 'A preferential-rate or premium-product gate.',
  },
  score_at_least_excellent: {
    claim: 'score_at_least_excellent',
    label: 'Excellent',
    detail: 'Proves only whether you are Excellent. Nothing else.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked: 'A best-tier gate.',
  },
  confidence: {
    claim: 'confidence',
    label: 'Confidence',
    detail:
      'How certain the score is, from 0 to 1 — low when your shared history is thin.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked:
      'An honest verifier wants this: it tells them how much weight the score deserves.',
  },
  coverage: {
    claim: 'coverage',
    label: 'Data coverage',
    detail:
      'What share of the expected financial data was actually available, from 0 to 1.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked: 'Same reason as confidence — it qualifies the number.',
  },
  score_as_of: {
    claim: 'score_as_of',
    label: 'Score date',
    detail: 'The date the underlying financial data reflects.',
    category: 'reputation',
    sensitivity: 'LOW',
    whyAsked: 'A six-month-old score is a different fact from a fresh one.',
  },

  model_version: {
    claim: 'model_version',
    label: 'Model version',
    detail: 'Which version of the Pravaah scoring model produced the number.',
    category: 'provenance',
    sensitivity: 'LOW',
    whyAsked:
      'Lets a verifier check the model against our published fairness audit.',
  },
  data_rails: {
    claim: 'data_rails',
    label: 'Data sources',
    detail:
      'Which regulated rails the data came from — for example Account Aggregator (India) or SGFinDex (Singapore). Never the accounts themselves.',
    category: 'provenance',
    sensitivity: 'LOW',
    whyAsked:
      'A regulated rail is why the score is trustworthy. This is the claim that earns their trust.',
  },
  consent_ref: {
    claim: 'consent_ref',
    label: 'Consent reference',
    detail:
      'The identifier of the consent artefact your data was shared under.',
    category: 'provenance',
    sensitivity: 'LOW',
    whyAsked:
      'An auditable pointer proving your data was used with your permission.',
  },
  kyc_level: {
    claim: 'kyc_level',
    label: 'Identity assurance',
    detail:
      'How strongly your identity was verified — for example that a government document and a liveness check both passed.',
    category: 'provenance',
    sensitivity: 'LOW',
    whyAsked:
      'Tells the verifier the score belongs to a real, checked person, without naming you.',
  },
}

// ── presentation templates ─────────────────────────────────────────────────
/**
 * Named request presets. A verifier asks by template, and the wallet shows the
 * template's purpose beside the claim list — so "needs X claims" becomes
 * "a cross-border landlord needs these five things, and here is why".
 *
 * Every template is deliberately the MINIMUM for its use case. `DOMESTIC_MICRO_LOAN`
 * asking for one boolean is not a toy: it is the strongest privacy claim in the
 * product, and it is a real, sufficient credit decision.
 */
export const PRESENTATION_TEMPLATES = {
  DOMESTIC_MICRO_LOAN: {
    id: 'DOMESTIC_MICRO_LOAN',
    label: 'Small loan eligibility',
    purpose: 'Confirm you clear the lender’s minimum reputation bar.',
    claims: ['score_at_least_good'],
  },
  DOMESTIC_LOAN: {
    id: 'DOMESTIC_LOAN',
    label: 'Risk-priced loan',
    purpose: 'Price a loan against your exact score and its confidence.',
    claims: [
      'given_name',
      'score_value',
      'score_band',
      'confidence',
      'score_as_of',
      'kyc_level',
    ],
  },
  CROSS_BORDER_RENTAL: {
    id: 'CROSS_BORDER_RENTAL',
    label: 'Cross-border tenancy',
    purpose:
      'Let a landlord abroad tie your reputation to the passport they already trust.',
    claims: [
      'given_name',
      'family_name',
      'nationality',
      'passport_number',
      'score_band',
      'score_as_of',
    ],
  },
  INSURANCE_PRICING: {
    id: 'INSURANCE_PRICING',
    label: 'Insurance pricing',
    purpose: 'Price cover against your score, its confidence and its coverage.',
    claims: [
      'score_value',
      'score_band',
      'confidence',
      'coverage',
      'model_version',
      'data_rails',
    ],
  },
  IDENTITY_ONLY: {
    id: 'IDENTITY_ONLY',
    label: 'Identity check',
    purpose: 'Confirm who you are, with no financial information at all.',
    claims: ['given_name', 'family_name', 'nationality', 'kyc_level'],
  },
  /**
   * Person to person — someone standing in front of you scanned your code.
   *
   * The only template whose verifier is another HUMAN rather than an institution, and
   * the reason it is a template at all: a peer scan must go through exactly the same
   * claim machinery as a lender's, or "a person asked" quietly becomes a second, weaker
   * disclosure path with no catalogue behind it.
   *
   * It carries `score_value` alongside `score_band` even though the exact number is HIGH
   * sensitivity. That is deliberate and it is safe here for one reason: a template is a
   * REQUEST, never a grant. The holder's consent screen starts with every box empty, so
   * asking for the number is the peer saying what they would like, and the holder still
   * decides. Leaving it out would instead make it un-askable — and "how do you actually
   * score" is the question a peer check exists to answer.
   *
   * `pravaah_id` is included so the result is quotable in a dispute: a face and a band
   * with no reference number is not something either side can later point at.
   */
  PEER_INTRODUCTION: {
    id: 'PEER_INTRODUCTION',
    label: 'Person-to-person check',
    purpose:
      'Someone you are dealing with in person wants to confirm who you are and how you score.',
    claims: [
      'given_name',
      'family_name',
      'nationality',
      'score_value',
      'score_band',
      'confidence',
      'score_as_of',
      'kyc_level',
      'pravaah_id',
    ],
  },
} as const satisfies Record<
  string,
  {
    id: string
    label: string
    purpose: string
    claims: readonly DisclosableClaim[]
  }
>

export type PresentationTemplateId = keyof typeof PRESENTATION_TEMPLATES

export const PresentationTemplateIdSchema = z.enum(
  Object.keys(PRESENTATION_TEMPLATES) as [
    PresentationTemplateId,
    ...PresentationTemplateId[],
  ],
)

/** Wallet/console helper: describe a list of claim keys for a human. */
export function describeClaims(
  claims: readonly string[],
): ClaimDescriptor[] {
  return claims
    .map((c) => CLAIM_CATALOGUE[c as DisclosableClaim])
    .filter((d): d is ClaimDescriptor => !!d)
}

/**
 * True when `claim` is one this credential type can selectively disclose. The
 * verify path uses this to reject a foreign claim name outright rather than
 * silently returning nothing for it.
 */
export function isDisclosableClaim(claim: string): claim is DisclosableClaim {
  return (DISCLOSABLE_CLAIMS as readonly string[]).includes(claim)
}
