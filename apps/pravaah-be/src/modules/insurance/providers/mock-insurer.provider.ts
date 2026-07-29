import { createHash, createHmac, timingSafeEqual } from 'crypto'

import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'
import { Ok, type Result } from '@/common/result/result'

import type {
  BindPolicyInput,
  InsurerClaimStatus,
  InsurerProvider,
  InsurerWebhookEvent,
  SubmitClaimInput,
} from '@/modules/insurance/providers/insurer.provider'

/**
 * The demonstration insurer.
 *
 * Deterministic on purpose. `MOCK-POL-<policyNumber>` and a claim reference
 * derived from `sha256(claimNumber)` mean the same input always produces the same
 * reference — so a retried bind is idempotent, a re-run demo tells the same story
 * twice, and CI does not depend on a random value.
 *
 * ## What it does NOT pretend to do
 *
 * It does not adjudicate. `submitClaim` returns `RECEIVED` and `getClaimStatus`
 * keeps returning `RECEIVED`, because a mock that invented an approval would be
 * fabricating the one judgement a licensed insurer exists to make — and the demo
 * would show a claims decision nobody made. Our own adjudication (the fraud gate,
 * the auto-approve ceiling, the human reviewer) is what decides whether a claimant
 * is paid, and that part is real.
 *
 * ## Why the webhook verification is genuine
 *
 * `verifyWebhook` is a real HMAC with a real timing-safe compare, not a stub that
 * returns `true`. The callback route is the most security-sensitive surface in the
 * module — an unauthenticated request that can move a claim's status — and a mock
 * that waved signatures through would mean the production path had never once been
 * exercised. Swapping in Acko then means changing a secret, not discovering that
 * the verification code has never run.
 */
@Injectable()
export class MockInsurerProvider implements InsurerProvider {
  readonly name = 'mock-insurer'

  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: MockInsurerProvider.name })
  }

  /**
   * Always true.
   *
   * The mock has nothing to configure, and saying so plainly is better than a
   * check that could fail and leave the module with no insurer at all. The
   * registry's job is to refuse a LIVE provider that is unconfigured — see
   * {@link InsuranceProviderRegistry}.
   */
  isConfigured(): boolean {
    return true
  }

  bindPolicy(
    input: BindPolicyInput,
  ): Promise<Result<{ insurerPolicyRef: string }>> {
    this.logger.info(`[${this.bindPolicy.name}] Bound at the mock insurer`, {
      policyNumber: input.policyNumber,
      productType: input.productType,
      riskTier: input.riskTier,
    })
    return Promise.resolve(
      Ok({ insurerPolicyRef: `MOCK-POL-${input.policyNumber}` }),
    )
  }

  submitClaim(
    input: SubmitClaimInput,
  ): Promise<Result<{ insurerClaimRef: string; status: InsurerClaimStatus }>> {
    /**
     * Derived from the claim number rather than random.
     *
     * A retried notification returns the SAME reference, so a crash between our
     * `submitClaim` call and persisting the result cannot leave one claim with two
     * insurer references — the failure mode M4 guards against with the rail's
     * idempotency key.
     */
    const insurerClaimRef = `MOCK-CLM-${createHash('sha256')
      .update(input.claimNumber)
      .digest('hex')
      .slice(0, 10)
      .toUpperCase()}`

    this.logger.info(`[${this.submitClaim.name}] Notified the mock insurer`, {
      claimNumber: input.claimNumber,
      insurerClaimRef,
    })
    return Promise.resolve(Ok({ insurerClaimRef, status: 'RECEIVED' as const }))
  }

  /**
   * Always `RECEIVED`.
   *
   * A real insurer drives status by webhook; a mock that progressed a claim on its
   * own would make the demo's adjudication look like it came from an underwriter.
   */
  getClaimStatus(
    insurerClaimRef: string,
  ): Promise<Result<{ status: InsurerClaimStatus }>> {
    // Logged rather than ignored, so a reconciliation sweep polling the mock is
    // visible in the same way a sweep against a real insurer would be. A silent
    // poll is one nobody can tell ran.
    this.logger.debug(
      `[${this.getClaimStatus.name}] Polled the mock insurer — status is always RECEIVED`,
      { insurerClaimRef },
    )
    return Promise.resolve(Ok({ status: 'RECEIVED' as const }))
  }

  /**
   * HMAC-SHA256 over the raw bytes, compared in constant time.
   *
   * Not `WEBHOOK_HMAC_SECRET` and not a timestamp-prefixed scheme — insurers
   * publish their own signing conventions, and this one signs the body alone
   * because that is what the mock's own signing script does. The replay defence
   * therefore comes from the `WebhookEvent` unique index rather than from a
   * freshness window, which is stated here so nobody assumes a window exists.
   */
  verifyWebhook(headers: Record<string, unknown>, rawBody: string): boolean {
    const raw: unknown =
      headers['x-insurer-signature'] ?? headers['X-Insurer-Signature']
    /**
     * A repeated header arrives as an array.
     *
     * The first element is taken and then type-checked below, rather than the array
     * being rejected outright: unlike M4's `Idempotency-Key` — where two values mean
     * two intents and choosing between them is a guess about money — a duplicated
     * signature header is a proxy artefact, and both copies verify the same body.
     */
    const signature: unknown = Array.isArray(raw) ? raw[0] : raw

    if (typeof signature !== 'string' || signature.length === 0) {
      this.logger.warn(
        `[${this.verifyWebhook.name}] Rejected an unsigned insurer callback`,
      )
      return false
    }

    const expected = createHmac('sha256', this.secret())
      .update(rawBody)
      .digest('hex')

    const provided = Buffer.from(signature)
    const computed = Buffer.from(expected)
    // Length check first: `timingSafeEqual` THROWS on a length mismatch rather
    // than returning false, which would turn a malformed signature into a 500.
    return (
      provided.length === computed.length && timingSafeEqual(provided, computed)
    )
  }

  /**
   * Parse a verified callback.
   *
   * Returns `null` on anything unrecognised rather than guessing. A signed body we
   * cannot parse means our parser and the insurer's payload have diverged, and the
   * caller answers 200 so the insurer stops retrying a message we can never accept
   * — the same treatment M4 gives an unparseable rail webhook.
   */
  parseWebhook(body: unknown): InsurerWebhookEvent | null {
    if (!body || typeof body !== 'object') return null
    const payload = body as Record<string, unknown>

    const insurerClaimRef =
      typeof payload.insurerClaimRef === 'string'
        ? payload.insurerClaimRef
        : null
    const insurerPolicyRef =
      typeof payload.insurerPolicyRef === 'string'
        ? payload.insurerPolicyRef
        : null

    /**
     * The event id falls back to a reference.
     *
     * A callback with no id at all would otherwise be undeduplicable, and an
     * undeduplicable claim-status event is one that can be replayed to move a
     * claim twice. Falling back to the reference means at most one status change
     * per claim per provider — a blunt but safe dedupe — and it is logged so a
     * real integration is fixed rather than silently tolerated.
     */
    const eventId =
      typeof payload.eventId === 'string' && payload.eventId.length > 0
        ? payload.eventId
        : (insurerClaimRef ?? insurerPolicyRef)
    if (!eventId) return null

    if (eventId === insurerClaimRef || eventId === insurerPolicyRef) {
      this.logger.warn(
        `[${this.parseWebhook.name}] Callback carried no eventId — deduping on the reference instead`,
        { eventId },
      )
    }

    const status = this.normaliseStatus(payload.status)
    const kind = insurerClaimRef ? 'CLAIM_STATUS' : 'POLICY_STATUS'

    return {
      eventId,
      kind,
      insurerClaimRef,
      insurerPolicyRef,
      status,
      approvedMinor: this.parseMinor(payload.approvedMinor),
      reason: typeof payload.reason === 'string' ? payload.reason : null,
    }
  }

  /**
   * Map a vendor status string onto our own vocabulary.
   *
   * Unknown values become `UNKNOWN` rather than being coerced to something
   * actionable. A status we do not recognise must not be read as an approval, and
   * `UNKNOWN` is what makes the claims service leave the claim where it is instead
   * of moving it on a guess.
   */
  private normaliseStatus(value: unknown): InsurerClaimStatus {
    if (typeof value !== 'string') return 'UNKNOWN'
    switch (value.trim().toUpperCase()) {
      case 'RECEIVED':
      case 'ACKNOWLEDGED':
        return 'RECEIVED'
      case 'IN_ASSESSMENT':
      case 'ASSESSING':
      case 'UNDER_REVIEW':
        return 'IN_ASSESSMENT'
      case 'APPROVED':
        return 'APPROVED'
      case 'REJECTED':
      case 'DENIED':
        return 'REJECTED'
      case 'SETTLED':
      case 'PAID':
        return 'SETTLED'
      default:
        return 'UNKNOWN'
    }
  }

  /** A minor-unit amount from a callback. Digit strings only — never a float. */
  private parseMinor(value: unknown): bigint | null {
    if (typeof value === 'string' && /^[0-9]{1,18}$/.test(value)) {
      return BigInt(value)
    }
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return BigInt(value)
    }
    return null
  }

  /**
   * The signing secret.
   *
   * Falls back to `'mock'` so a developer with no env can exercise the signed
   * webhook path — and the fallback is LOGGED, because a fallback secret in a
   * deployed environment would mean anybody could sign a claim-status callback.
   */
  private secret(): string {
    const configured = this.config.get<string>(ENV.INSURANCE.WEBHOOK_SECRET)
    if (configured) return configured

    this.logger.warn(
      `[${this.secret.name}] INSURER_WEBHOOK_SECRET is unset — using the development fallback. Set it in any deployed environment.`,
    )
    return 'mock'
  }
}
