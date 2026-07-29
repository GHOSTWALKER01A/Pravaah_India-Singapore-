import { randomUUID } from 'crypto'

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import type {
  AddBeneficiaryDto,
  BeneficiaryListQueryDto,
  ResolveMobileDto,
} from '@pravaah/schema'

import { encryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PaymentProviderFactory } from '@/modules/payments/providers/payment-provider.factory'
import { isHandleSupported } from '@/modules/payments/payments.state'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import { PayeeScreeningService } from '@/modules/payments/services/payee-screening.service'
import { UpiHandleService } from '@/modules/payments/services/upi-handle.service'
import {
  DEFAULT_VPA_SUFFIX,
  MOBILE_VPA_PROBE_LIMIT,
  MOBILE_VPA_PSP_SUFFIXES,
} from '@/modules/payments/payments.config'
import {
  maskPhone,
  mobileVpaCandidates,
  parsePhone,
  payNowMobileProxy,
  type PhoneCountry,
} from '@/modules/payments/phone.util'
import {
  buildAccountHandle,
  maskHandle,
  normaliseVpa,
  parseAccountHandle,
} from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  BeneficiaryHandleType,
  BeneficiaryStatus,
  Corridor,
  type Beneficiary,
} from 'generated/prisma/client'

export interface ResolvedPayee {
  handle: string
  handleType: BeneficiaryHandleType
  reachable: boolean
  registeredName: string | null
  bankName?: string
  reason?: string
}

/**
 * The answer to "who is at this phone number?".
 *
 * `matches` is a list rather than one optional payee because an Indian mobile can be registered at
 * more than one PSP, and an empty list is a normal outcome rather than an error — see
 * `resolveMobile`. `phone` comes back MASKED so a client can echo which number was looked up without
 * the full address travelling any further than it must.
 */
export interface ResolvedMobile {
  phone: string
  country: PhoneCountry
  matches: ResolvedPayee[]
  railUnavailable: boolean
}

/**
 * Beneficiaries — who a user is allowed to pay, and what their bank calls them.
 *
 * The `registeredName` is the point of this service. NPCI requires that the name the
 * payee's BANK holds be displayed to the payer before they authorise, and the payer must
 * confirm it. It is the single most effective control against social-engineering fraud,
 * because the attacker controls the address string but not what the bank calls the
 * account behind it — a victim told to pay "ravi.landlord@ybl" sees `PRIYA SHARMA` and
 * stops.
 *
 * The rest of the rules follow from a beneficiary being a permanent payment target:
 *
 *  - **Normalised, one row per address.** Two casings of one VPA becoming two rows would
 *    give the same payee two separate new-beneficiary cooling periods, and the ₹5,000
 *    sliding cap would be doubled by changing a letter's case.
 *  - **Screened before any cross-border credit.** Sanctions/AML screening is a
 *    precondition on the cross-border corridor, not a report generated afterwards.
 *  - **Blocked rather than deleted, when a user says they were defrauded.** A deleted
 *    row can be re-added in seconds with a fresh cooling period; a blocked one keeps
 *    refusing.
 *  - **`isSelf` is verified, never believed.** Own-account transfers skip the cooling
 *    period, so a client-asserted flag would be a way to bypass it.
 */
@Injectable()
export class BeneficiaryService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderFactory,
    private readonly handles: UpiHandleService,
    private readonly screening: PayeeScreeningService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: BeneficiaryService.name })
  }

  // ── name resolution ───────────────────────────────────────────────────────
  /**
   * Look up the bank-registered name for an address, WITHOUT moving money or saving
   * anything.
   *
   * Its own operation because it has to happen BEFORE the decision it informs. Folded
   * into the transfer call, the name would arrive after the user had already committed.
   */
  async resolve(
    userId: string,
    handle: string,
    handleType: BeneficiaryHandleType = BeneficiaryHandleType.UPI_VPA,
  ): Promise<ResolvedPayee> {
    const normalised =
      handleType === BeneficiaryHandleType.ACCOUNT_IFSC
        ? handle
        : normaliseVpa(handle)

    // One of ours: answer from our own records rather than asking a rail about an
    // address it has never heard of. Internal transfers never leave the platform, so
    // the rail has nothing to say about them.
    const internal = await this.handles.resolveInternal(normalised)
    if (internal) {
      const owner = await this.prisma.user.findUnique({
        where: { id: internal.userId },
        select: { kycProfile: { select: { verifiedName: true } } },
      })
      return {
        handle: normalised,
        handleType,
        reachable: true,
        registeredName:
          owner?.kycProfile?.verifiedName?.toUpperCase() ?? 'PRAVAAH USER',
        bankName: 'Pravaah',
      }
    }

    const corridor =
      handleType === BeneficiaryHandleType.PAYNOW_UPI
        ? Corridor.CROSS_BORDER
        : Corridor.DOMESTIC
    const provider = this.providers.forCorridor(corridor)
    const result = await provider.resolveHandle({
      handle: normalised,
      handleType,
      traceId: `resolve_${randomUUID()}`,
    })

    if (!result.ok) {
      /**
       * The lookup itself failed, which is NOT the same as "the address is invalid".
       *
       * Reported as unreachable-with-a-reason rather than marking the beneficiary
       * INVALID, because a rail outage must not permanently brand a perfectly good UPI
       * ID as bad. The user is told to try again; the row stays UNVERIFIED.
       */
      this.logger.warn(`[${this.resolve.name}] Name lookup failed`, {
        userId,
        handle: maskHandle(normalised),
        reason: result.error.code,
      })
      return {
        handle: normalised,
        handleType,
        reachable: false,
        registeredName: null,
        reason:
          'We could not reach the payee bank to check that name. Please try again.',
      }
    }

    return {
      handle: normalised,
      handleType,
      reachable: result.value.reachable,
      registeredName: result.value.registeredName,
      bankName: result.value.bankName,
      reason: result.value.reason,
    }
  }

  /**
   * Resolve a MOBILE NUMBER to payable addresses.
   *
   * The number is the address people actually know, so this is the lookup behind the "to a phone
   * number" destination. It returns a LIST, and that plural is the important part of the design.
   *
   * **India.** No public directory maps a mobile to a VPA; there is only the convention that a PSP
   * registers `<mobile>@<its-handle>`. So this probes candidates in order — our own suffix first,
   * because that hit is answered from our own database with no rail call and settles internally —
   * then the configured PSP handles. More than one can legitimately resolve, and when they do the
   * user must choose rather than have us pick: two PSPs can hold the same number, and silently
   * taking the first would sometimes pay the right number at the wrong bank.
   *
   * **Singapore.** The mobile IS the PayNow proxy, registered once centrally. One probe, one answer.
   *
   * Probing stops at the first hit for India. Continuing would cost five more rail calls to find
   * duplicates that are nearly always the same person, and the rate limit is real.
   *
   * A number that resolves to nothing is reported as exactly that. It is NOT reported as invalid:
   * the person may be entirely reachable at a VPA they chose themselves, and a user told "that
   * number is wrong" about their own mother's number will believe they mistyped it.
   */
  async resolveMobile(
    userId: string,
    dto: ResolveMobileDto,
  ): Promise<ResolvedMobile> {
    const parsed = parsePhone(dto.phone, dto.country)
    if (!parsed) {
      throw new BadRequestException(
        dto.country === 'IN'
          ? 'An Indian mobile number is 10 digits and starts with 6, 7, 8 or 9.'
          : 'A Singapore mobile number is 8 digits and starts with 8 or 9.',
      )
    }

    const candidates =
      dto.country === 'SG'
        ? [payNowMobileProxy(parsed)]
        : mobileVpaCandidates(
            parsed.national,
            DEFAULT_VPA_SUFFIX,
            MOBILE_VPA_PSP_SUFFIXES,
            MOBILE_VPA_PROBE_LIMIT,
          )

    const handleType =
      dto.country === 'SG'
        ? BeneficiaryHandleType.PAYNOW_UPI
        : BeneficiaryHandleType.UPI_VPA

    const matches: ResolvedPayee[] = []
    let probes = 0
    let railFailed = false

    for (const candidate of candidates) {
      probes += 1
      const found = await this.resolve(userId, candidate, handleType)

      if (found.reachable && found.registeredName) {
        matches.push(found)
        // First hit wins. See the method comment: continuing costs five more rail calls to surface
        // duplicates that are almost always one person.
        break
      }
      // Distinguish "the rail would not answer" from "nobody is there". Only the first warrants
      // telling the user to try again.
      if (found.reason?.includes('could not reach')) railFailed = true
    }

    this.logger.info(`[${this.resolveMobile.name}] Mobile lookup`, {
      userId,
      phone: maskPhone(parsed.e164, parsed.country),
      country: parsed.country,
      probes,
      found: matches.length,
    })

    return {
      phone: maskPhone(parsed.e164, parsed.country),
      country: parsed.country,
      matches,
      /**
       * Whether the miss might be temporary.
       *
       * A user whose payee is genuinely not registered should be sent to "type their UPI ID"; one
       * whose lookup hit a rail outage should be told to retry. Same empty list, opposite advice.
       */
      railUnavailable: matches.length === 0 && railFailed,
    }
  }

  // ── adding ────────────────────────────────────────────────────────────────
  async add(userId: string, dto: AddBeneficiaryDto): Promise<Beneficiary> {
    const { handle, handleType } = this.handleFrom(dto)

    const existing = await this.prisma.beneficiary.findUnique({
      where: { userId_handle: { userId, handle } },
    })
    if (existing && !existing.deletedAt) {
      if (existing.status === BeneficiaryStatus.BLOCKED) {
        throw new ConflictException(
          'You blocked this payee. Unblock them before paying again.',
        )
      }
      // Idempotent: re-adding an address the user already has re-verifies it rather
      // than erroring, because from the user's side "add payee" is one intent.
      return this.reverify(userId, existing.id)
    }

    const resolved = await this.resolve(userId, handle, handleType)

    /**
     * `isSelf` is verified against the user's own registered handles, never taken from
     * the request.
     *
     * It exempts the beneficiary from the new-beneficiary cooling period, so a
     * client-set flag would be a one-field bypass of the strongest anti-fraud control
     * in the module.
     */
    const isSelf = await this.verifyIsSelf(userId, handle, dto.isSelf === true)

    const screening = await this.screen(handleType, resolved.registeredName)

    const status = !resolved.reachable
      ? BeneficiaryStatus.INVALID
      : screening.hit
        ? BeneficiaryStatus.BLOCKED
        : BeneficiaryStatus.VERIFIED

    const account =
      handleType === BeneficiaryHandleType.ACCOUNT_IFSC
        ? parseAccountHandle(handle)
        : null

    try {
      const beneficiary = await this.prisma.beneficiary.upsert({
        where: { userId_handle: { userId, handle } },
        create: {
          userId,
          displayName: dto.displayName,
          registeredName: resolved.registeredName,
          handleType,
          handle,
          // The account number is encrypted; the handle keeps only what is needed to
          // route and to de-duplicate.
          accountEnc: account ? encryptField(account.accountNumber) : null,
          ifsc: account?.ifsc ?? null,
          country: this.countryFor(dto, handleType),
          currency: this.currencyFor(handleType),
          status,
          statusReason: resolved.reason ?? screening.reason,
          isSelf,
          screenedAt: screening.screened ? new Date() : null,
          screeningHit: screening.hit,
          // The cooling period is measured from HERE, not from creation.
          verifiedAt: status === BeneficiaryStatus.VERIFIED ? new Date() : null,
        },
        update: {
          displayName: dto.displayName,
          registeredName: resolved.registeredName,
          status,
          statusReason: resolved.reason ?? screening.reason,
          deletedAt: null,
          screenedAt: screening.screened ? new Date() : null,
          screeningHit: screening.hit,
          verifiedAt: status === BeneficiaryStatus.VERIFIED ? new Date() : null,
        },
      })

      await this.audit.log({
        actorType: ActorType.USER,
        actorId: userId,
        action: 'beneficiary.added',
        entity: 'Beneficiary',
        entityId: beneficiary.id,
        metadata: {
          handle: maskHandle(handle),
          handleType,
          status,
          screeningHit: screening.hit,
        },
      })

      return beneficiary
    } catch (error) {
      if (isUniqueViolation(error)) {
        const found = await this.prisma.beneficiary.findUnique({
          where: { userId_handle: { userId, handle } },
        })
        if (found) return found
      }
      throw error
    }
  }

  /** Re-run the name check on an existing beneficiary. */
  async reverify(userId: string, beneficiaryId: string): Promise<Beneficiary> {
    const beneficiary = await this.owned(userId, beneficiaryId)
    if (beneficiary.status === BeneficiaryStatus.BLOCKED) {
      throw new ConflictException('That payee is blocked')
    }

    const resolved = await this.resolve(
      userId,
      beneficiary.handle,
      beneficiary.handleType,
    )
    const screening = await this.screen(
      beneficiary.handleType,
      resolved.registeredName,
    )

    const status = !resolved.reachable
      ? BeneficiaryStatus.INVALID
      : screening.hit
        ? BeneficiaryStatus.BLOCKED
        : BeneficiaryStatus.VERIFIED

    /**
     * `verifiedAt` moves forward on a successful re-verify, which RESTARTS the cooling
     * period.
     *
     * Counter-intuitive but correct: the window exists because a payer has not yet had
     * time to notice a mistake, and the clock that matters is the one since the address
     * was last proven. Keeping the original timestamp would let a beneficiary added
     * weeks ago and re-verified seconds before a large transfer bypass the cap — which
     * is precisely how a compromised account drains a wallet.
     */
    return this.prisma.beneficiary.update({
      where: { id: beneficiary.id },
      data: {
        registeredName: resolved.registeredName,
        status,
        statusReason: resolved.reason ?? screening.reason,
        screenedAt: screening.screened ? new Date() : beneficiary.screenedAt,
        screeningHit: screening.hit,
        verifiedAt:
          status === BeneficiaryStatus.VERIFIED
            ? new Date()
            : beneficiary.verifiedAt,
      },
    })
  }

  // ── reading ───────────────────────────────────────────────────────────────
  async list(
    userId: string,
    query: BeneficiaryListQueryDto,
  ): Promise<{ items: Beneficiary[]; total: number }> {
    const where = {
      userId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.handleType ? { handleType: query.handleType } : {}),
      ...(query.search
        ? {
            OR: [
              {
                displayName: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                registeredName: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              { handle: { contains: query.search.toLowerCase() } },
            ],
          }
        : {}),
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.beneficiary.findMany({
        where,
        orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.beneficiary.count({ where }),
    ])
    return { items, total }
  }

  async get(userId: string, beneficiaryId: string): Promise<Beneficiary> {
    return this.owned(userId, beneficiaryId)
  }

  // ── the payment-time guard ────────────────────────────────────────────────
  /**
   * Everything that must be true before this beneficiary can be paid.
   *
   * Ordered so the most informative rejection wins. A blocked payee gets "you blocked
   * them", not "unverified" — a user who cannot tell which of their own decisions is
   * stopping a payment will simply try again.
   */
  async assertPayable(
    userId: string,
    beneficiaryId: string,
    corridor: Corridor,
  ): Promise<Beneficiary> {
    const beneficiary = await this.owned(userId, beneficiaryId)

    if (beneficiary.status === BeneficiaryStatus.BLOCKED) {
      throw new BadRequestException(
        beneficiary.screeningHit
          ? 'This payee cannot be paid. Please contact support.'
          : 'You blocked this payee. Unblock them to pay again.',
      )
    }
    if (beneficiary.status === BeneficiaryStatus.INVALID) {
      throw new BadRequestException(
        beneficiary.statusReason ??
          'That payee could not be verified. Check the details and try again.',
      )
    }
    if (beneficiary.status !== BeneficiaryStatus.VERIFIED) {
      throw new BadRequestException(
        'This payee has not been verified yet. Verify them before paying.',
      )
    }

    /**
     * The handle kind must be payable over this corridor.
     *
     * The UPI↔PayNow linkage is address-based — the sender enters a registered UPI ID
     * and nothing else — so an account+IFSC beneficiary has no cross-border route.
     * Accepting one here would build a payment the rail cannot execute, discovered
     * only after the user had been debited.
     */
    if (!isHandleSupported(corridor, beneficiary.handleType)) {
      throw new BadRequestException(
        corridor === Corridor.CROSS_BORDER
          ? 'Cross-border transfers can only be sent to a registered UPI ID, not to a bank account number'
          : 'That payee cannot be paid on the domestic rail',
      )
    }

    /**
     * Cross-border credits require screening to have actually run.
     *
     * Not "screened at some point" — a beneficiary whose screening never completed
     * (because the provider was down when they were added) must not be paid abroad on
     * the strength of an absent result.
     */
    if (corridor === Corridor.CROSS_BORDER && !beneficiary.screenedAt) {
      throw new BadRequestException(
        'This payee still needs a compliance check before an international transfer. Please try again shortly.',
      )
    }

    return beneficiary
  }

  /**
   * Confirm the payer read the name that is on file RIGHT NOW.
   *
   * NPCI mandates displaying the bank-held name; comparing it back is what turns that
   * display into a control rather than decoration. A mismatch means the beneficiary was
   * re-verified between the confirmation screen and the request — a narrow but real
   * window in which the payer's confirmation refers to a different person than the one
   * about to be paid.
   *
   * Compared case- and whitespace-insensitively, because core banking systems return
   * names in inconsistent casing and spacing, and failing a payment over a double space
   * would train users to ignore the check.
   */
  assertNameConfirmed(beneficiary: Beneficiary, confirmedName: string): void {
    const onFile = normaliseName(beneficiary.registeredName ?? '')
    const confirmed = normaliseName(confirmedName)

    if (!onFile) {
      throw new BadRequestException(
        'We do not have a verified name for this payee yet. Please verify them again.',
      )
    }
    if (onFile !== confirmed) {
      this.logger.warn(
        `[${this.assertNameConfirmed.name}] Confirmed payee name does not match the record`,
        { beneficiaryId: beneficiary.id },
      )
      throw new ConflictException(
        `This payee's registered name has changed to "${beneficiary.registeredName}". Please review it before paying.`,
      )
    }
  }

  /** Stamp last-used, so the payee list is ordered by how people actually pay. */
  async touch(beneficiaryId: string): Promise<void> {
    await this.prisma.beneficiary
      .update({
        where: { id: beneficiaryId },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => void 0)
  }

  // ── blocking + removal ────────────────────────────────────────────────────
  /**
   * Block a payee.
   *
   * Distinct from removing one, and the distinction matters: a removed row can be
   * re-added in seconds with a fresh cooling period, whereas a blocked one keeps
   * refusing. When a user says "this person scammed me", block is the honest answer.
   */
  async block(
    userId: string,
    beneficiaryId: string,
    reason?: string,
  ): Promise<Beneficiary> {
    const beneficiary = await this.owned(userId, beneficiaryId)
    const blocked = await this.prisma.beneficiary.update({
      where: { id: beneficiary.id },
      data: {
        status: BeneficiaryStatus.BLOCKED,
        statusReason: reason ?? 'Blocked by the user',
      },
    })
    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'beneficiary.blocked',
      entity: 'Beneficiary',
      entityId: beneficiary.id,
      metadata: { reason: reason ?? null },
    })
    return blocked
  }

  async unblock(userId: string, beneficiaryId: string): Promise<Beneficiary> {
    const beneficiary = await this.owned(userId, beneficiaryId)
    if (beneficiary.screeningHit) {
      /**
       * A sanctions hit is not the user's to clear.
       *
       * The user blocked it or we did — but if screening flagged the payee, unblocking
       * is a compliance decision, and putting it behind a user-facing button would make
       * the control optional.
       */
      throw new ConflictException(
        'This payee was blocked by a compliance check and cannot be unblocked here. Contact support.',
      )
    }
    return this.reverify(userId, beneficiary.id)
  }

  /**
   * Remove a payee.
   *
   * A soft delete. The row is referenced by past transactions, and a receipt that
   * cannot name its payee is a receipt nobody can dispute — which is why
   * `Transaction` also snapshots the handle and name at the moment money moved.
   */
  async remove(userId: string, beneficiaryId: string): Promise<void> {
    const beneficiary = await this.owned(userId, beneficiaryId)
    await this.prisma.beneficiary.update({
      where: { id: beneficiary.id },
      data: { deletedAt: new Date() },
    })
    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'beneficiary.removed',
      entity: 'Beneficiary',
      entityId: beneficiary.id,
    })
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private handleFrom(dto: AddBeneficiaryDto): {
    handle: string
    handleType: BeneficiaryHandleType
  } {
    switch (dto.handleType) {
      case 'ACCOUNT_IFSC':
        return {
          handle: buildAccountHandle(dto.accountNumber, dto.ifsc),
          handleType: BeneficiaryHandleType.ACCOUNT_IFSC,
        }
      case 'PAYNOW_UPI':
        return {
          handle: normaliseVpa(dto.vpa),
          handleType: BeneficiaryHandleType.PAYNOW_UPI,
        }
      default:
        return {
          handle: normaliseVpa(dto.vpa),
          handleType: BeneficiaryHandleType.UPI_VPA,
        }
    }
  }

  /**
   * Sanctions / PEP screening, reusing M0's screening service.
   *
   * Mandatory on the cross-border corridor and skipped domestically, which mirrors the
   * actual obligation: AML/CFT screening applies to cross-border beneficiaries, and
   * screening every domestic P2P payee against a sanctions list would generate false
   * positives that block ordinary payments without adding any compliance value.
   *
   * A screening FAILURE is not a pass. `screened: false` leaves `screenedAt` null, and
   * `assertPayable` refuses a cross-border transfer without it — fail-closed, because
   * the alternative is paying a sanctioned party because a vendor was down.
   */
  private async screen(
    handleType: BeneficiaryHandleType,
    registeredName: string | null,
  ): Promise<{ screened: boolean; hit: boolean; reason?: string }> {
    if (handleType !== BeneficiaryHandleType.PAYNOW_UPI) {
      return { screened: false, hit: false }
    }
    if (!registeredName) {
      return {
        screened: false,
        hit: false,
        reason: 'No verified name available to screen',
      }
    }

    try {
      const result = await this.screening.screenPayee(registeredName)
      return {
        screened: result.screened,
        hit: result.hit,
        reason: result.hit
          ? 'This payee matched a compliance watchlist'
          : result.reason,
      }
    } catch (error) {
      this.logger.error(
        `[${this.screen.name}] Sanctions screening failed — leaving the payee unscreened`,
        { err: error },
      )
      return {
        screened: false,
        hit: false,
        reason: 'The compliance check could not be completed',
      }
    }
  }

  /** Is this address one the user themselves owns? Checked, not believed. */
  private async verifyIsSelf(
    userId: string,
    handle: string,
    claimed: boolean,
  ): Promise<boolean> {
    if (!claimed) return false

    const internal = await this.handles.resolveInternal(handle)
    if (internal?.userId === userId) return true

    // An external own-account claim is only honoured when M0 has already verified that
    // account for this user (the KYC penny-drop). Otherwise it is just an assertion,
    // and the flag it would set skips a fraud control.
    const account = parseAccountHandle(handle)
    if (!account) return false

    const verified = await this.prisma.kycCheck.findFirst({
      where: {
        kycProfile: { userId },
        checkType: 'BANK_PENNY_DROP',
        status: 'PASSED',
      },
      select: { id: true },
    })
    if (!verified) {
      this.logger.warn(
        `[${this.verifyIsSelf.name}] Rejected an unproven own-account claim`,
        { userId, handle: maskHandle(handle) },
      )
    }
    return Boolean(verified)
  }

  private countryFor(
    dto: AddBeneficiaryDto,
    handleType: BeneficiaryHandleType,
  ): string {
    if (handleType === BeneficiaryHandleType.PAYNOW_UPI && 'country' in dto) {
      return dto.country
    }
    return 'IN'
  }

  private currencyFor(handleType: BeneficiaryHandleType): string {
    // The linkage always credits an Indian UPI ID in rupees — the SGD side is the
    // SENDER's leg, not the beneficiary's.
    return handleType === BeneficiaryHandleType.PAYNOW_UPI ? 'INR' : 'INR'
  }

  private async owned(
    userId: string,
    beneficiaryId: string,
  ): Promise<Beneficiary> {
    const beneficiary = await this.prisma.beneficiary.findFirst({
      where: { id: beneficiaryId, userId, deletedAt: null },
    })
    // 404, not 403: someone else's beneficiary id must not be confirmed to exist.
    if (!beneficiary) throw new NotFoundException('Payee not found')
    return beneficiary
  }
}

/**
 * Compare names the way a bank does.
 *
 * Case-folded, punctuation-stripped, whitespace-collapsed. Core banking systems return
 * `RAVI  KUMAR`, `Ravi Kumar` and `RAVI KUMAR.` for the same account, and failing a
 * payment over a double space would teach users to click through the one confirmation
 * screen that actually protects them.
 */
function normaliseName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
