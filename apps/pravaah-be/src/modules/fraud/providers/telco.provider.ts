/**
 * SIM-swap intelligence, behind an interface.
 *
 * ## What this abstracts, and the honest limit
 *
 * In production, SIM-swap detection is a TELCO capability, not an app one. The
 * real mechanisms are a carrier SIM-swap API (Vodafone Idea / Airtel / Jio in
 * India, Singtel / StarHub / M1 in Singapore, or an aggregator like TeleSign or
 * Prove), NPCI's SIM-Binding-Certificate handshake, or the GSMA Open Gateway
 * `SimSwap` API. Every one of those requires a commercial agreement and, in the
 * NPCI case, PSP accreditation. None is available to a hackathon build.
 *
 * So M6 ships a DETERMINISTIC implementation of the real contract. What is
 * genuinely ours: the detection LOGIC (serial-hash mismatch → `SUSPECTED_SWAP` →
 * cooling-off → recovery only after a step-up), the webhook replay defence, and
 * the fail-safe posture. What is theirs: the authoritative answer to "was this
 * number re-issued". Swapping in a real carrier is a provider registration and a
 * credential, not a rewrite — which is the same line M4 draws around the
 * cross-border rail and M5 around the insurer.
 */
export const TELCO_PROVIDER = Symbol('TELCO_PROVIDER')

export interface SimVerification {
  /** Whether the presented serial matches the carrier's current record. */
  matched: boolean
  /**
   * When the carrier last re-issued this number's SIM.
   *
   * The signal that matters even when `matched` is true: a SIM swapped two hours
   * ago that now matches is a swap we observed AFTER the fact, and the transfer it
   * is about to authorise is the one worth stopping.
   */
  lastChangedAt?: Date
  /**
   * Whether the provider could answer at all.
   *
   * Distinct from `matched: false`, and the distinction is the whole fail-safe
   * story. "The carrier says this is the wrong SIM" and "the carrier did not
   * answer" are different facts, and collapsing them into one boolean forces a
   * choice between blocking every user during an outage and trusting every SIM
   * during one.
   */
  available: boolean
  /** Provider-side detail for the audit trail. Never shown to a user. */
  detail?: string
}

export interface TelcoProvider {
  /** Provider name, as recorded on `DeviceEvent` and `WebhookEvent`. */
  readonly name: string

  /** Whether credentials are present. A provider that cannot answer says so. */
  isConfigured(): boolean

  /**
   * Ask the carrier whether a presented SIM serial is the current one.
   *
   * Takes HASHES, not the raw mobile number or ICCID. A provider that needed the
   * plaintext would have to be handed a subscriber identifier on every risk
   * evaluation, which is precisely the centralised-PII shape M6 exists to avoid.
   * A real carrier integration hashes on ITS side of the boundary; the dev
   * provider compares hashes directly.
   */
  verifySim(mobileHash: string, simSerialHash: string): Promise<SimVerification>

  /**
   * Verify a SIM-change callback's signature over the RAW bytes.
   *
   * Raw, not the parsed body: `JSON.stringify(parsed)` re-orders keys and drops
   * insignificant whitespace, so a signature computed over the original payload
   * will not match one computed over a re-serialised copy. This is the same trap
   * M4's and M5's webhook verification calls out.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean
}
