import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { ENV } from '@/constants/environment.constants'
import {
  decryptField,
  encryptField,
  maskAccount,
} from '@/common/crypto/field-crypto.util'
import { DEFAULT_VPA_SUFFIX } from '@/modules/payments/payments.config'
import { isUniqueViolation } from '@/modules/payments/services/ledger.service'
import {
  isReservedLocalPart,
  normaliseVpa,
  parseVpa,
  vpaCandidates,
} from '@/modules/payments/vpa.util'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  KycStatus,
  UpiHandleStatus,
  type UpiHandle,
} from 'generated/prisma/client'

/**
 * The user's own UPI address — `ravi@pravaah`.
 *
 * A VPA is a permanent, publicly payable identifier, and that shapes every rule here:
 *
 *  - **It is never recycled.** A DEACTIVATED row is kept forever and its `vpa` is never
 *    reissued. The failure mode is severe and easy to overlook: a payer with
 *    `ravi@pravaah` saved in their address book — or a printed QR on a shopfront —
 *    would keep sending money to that string, and it would arrive in a stranger's
 *    wallet. The unique index covers deactivated rows, which is what makes this
 *    impossible rather than merely intended.
 *  - **Allocation walks candidates against the index.** Any "is it free?" check is
 *    stale the moment it returns, so the database decides.
 *  - **Reserved local parts are refused.** Somebody holding `support@pravaah` or
 *    `refund@pravaah` can impersonate us to every other user, and the resulting fraud
 *    is indistinguishable from an official request.
 *  - **KYC first.** An address that can receive money, bound to an unverified identity,
 *    is a mule account with our branding on it.
 */
@Injectable()
export class UpiHandleService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: UpiHandleService.name })
  }

  private suffix(): string {
    return (
      this.config.get<string>(ENV.PAYMENTS.VPA_SUFFIX)?.trim().toLowerCase() ??
      DEFAULT_VPA_SUFFIX
    )
  }

  /** The user's handles, primary first. */
  list(userId: string): Promise<UpiHandle[]> {
    return this.prisma.upiHandle.findMany({
      where: { userId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })
  }

  async primary(userId: string): Promise<UpiHandle | null> {
    return this.prisma.upiHandle.findFirst({
      where: { userId, status: UpiHandleStatus.ACTIVE },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })
  }

  /**
   * Allocate a handle. Idempotent — an existing active handle is returned as-is.
   *
   * Candidates are tried in order and the first INSERT that the unique index accepts
   * wins. That is the only race-free way to do this: a `findUnique` before the create
   * would let two concurrent requests both see the address as free.
   */
  async allocate(userId: string, requested?: string): Promise<UpiHandle> {
    /**
     * The idempotency guard must NOT depend on status, and this line is why the dev database ended
     * up with three rows carrying the same address.
     *
     * It used `primary()`, which filters on `status: ACTIVE`. Combined with handles being created
     * PENDING, that meant the guard never matched: every visit to the Pay tab called `allocate`,
     * found no ACTIVE handle, and fell through to create another row. The missing `vpa` unique
     * index in that database let all of them succeed with the same first candidate, so the rows
     * multiplied silently — one per screen visit.
     *
     * `findFirst` over any handle that has not been retired is the correct guard. A holder with a
     * PENDING or BLOCKED address already HAS an address; the answer to "allocate me one" is that
     * one, and whatever is wrong with it is a separate question from whether to mint another.
     */
    const existing = await this.prisma.upiHandle.findFirst({
      where: {
        userId,
        status: { not: UpiHandleStatus.DEACTIVATED },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })
    if (existing && !requested) return existing

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pravaahId: true, kycStatus: true, kycProfile: true },
    })
    if (!user) throw new NotFoundException('User not found')

    /**
     * KYC gate.
     *
     * A UPI address is a way to RECEIVE money from strangers. Handing one to an
     * unverified identity creates a mule account carrying our handle, and the payments
     * are irreversible by the time anyone notices.
     */
    if (user.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException(
        'Complete your identity verification before creating a UPI ID',
      )
    }

    const candidates = requested
      ? [this.validateRequested(requested)]
      : vpaCandidates(
          user.kycProfile?.verifiedName ?? user.pravaahId ?? userId,
          this.suffix(),
        )

    const isFirst =
      (await this.prisma.upiHandle.count({ where: { userId } })) === 0

    for (const vpa of candidates) {
      try {
        const handle = await this.prisma.upiHandle.create({
          data: {
            userId,
            vpa,
            suffix: this.suffix(),
            /**
             * ACTIVE on allocation, because the KYC gate above has already been passed.
             *
             * This was `PENDING`, reasoned as "PENDING until a penny-drop proves the account
             * behind it is real — an address that resolves to nothing is worse than no address:
             * a payer's money leaves and has nowhere to land." The fear was right. The
             * conclusion did not follow for a wallet product, and it made receiving impossible
             * for every user.
             *
             * Money paid to a Pravaah address lands in the holder's USER_WALLET ledger account,
             * which exists from the moment the user does. It does not transit their bank. So
             * there is no "nowhere to land" — the destination is a ledger row we control, not an
             * external account that could be closed or mistyped. A linked bank account is what
             * WITHDRAWAL needs, and withdrawal enforces that on its own.
             *
             * Left as PENDING the address was a dead end rather than a cautious state, because
             * nothing in the product can supply what `activate()` demands. It needs
             * `{ accountNumber, ifsc }`, and M0's penny-drop returns only
             * `{ verified, registeredName }` — it discards the account number it was handed. So
             * no code path existed that could ever move a handle out of PENDING, and the
             * consequences were silent: `resolveInternal` ignores non-ACTIVE handles, so every
             * payment to the address was refused, and `QrService.create` requires ACTIVE, so no
             * QR could be minted either.
             *
             * The mule risk is still covered, by the KYC gate above: an unverified identity gets
             * no address at all.
             */
            status: UpiHandleStatus.ACTIVE,
            verifiedAt: new Date(),
            isPrimary: isFirst,
          },
        })
        this.logger.info(`[${this.allocate.name}] UPI ID allocated`, {
          userId,
          vpa,
        })
        return handle
      } catch (error) {
        if (isUniqueViolation(error)) continue
        throw error
      }
    }

    if (requested) {
      throw new ConflictException(
        'That UPI ID is already taken. Please choose another.',
      )
    }
    throw new ConflictException(
      'We could not allocate a UPI ID right now. Please try again.',
    )
  }

  private validateRequested(requested: string): string {
    const normalised = normaliseVpa(
      requested.includes('@') ? requested : `${requested}@${this.suffix()}`,
    )
    const parsed = parseVpa(normalised)
    if (!parsed) {
      throw new BadRequestException('That is not a valid UPI ID')
    }
    if (parsed.handle !== this.suffix()) {
      throw new BadRequestException(
        `A UPI ID created here must end in @${this.suffix()}`,
      )
    }
    if (isReservedLocalPart(parsed.localPart)) {
      throw new BadRequestException('That UPI ID is reserved')
    }
    return parsed.vpa
  }

  /**
   * Activate a handle once the linked account has been proven real.
   *
   * The account number is stored encrypted and never returned in full — a linked
   * account is exactly the field a support tool should not be able to read casually.
   */
  async activate(
    userId: string,
    handleId: string,
    linked: { accountNumber: string; ifsc: string; bankName?: string },
  ): Promise<UpiHandle> {
    const handle = await this.owned(userId, handleId)
    if (handle.status === UpiHandleStatus.BLOCKED) {
      throw new ConflictException('That UPI ID is blocked')
    }

    return this.prisma.upiHandle.update({
      where: { id: handle.id },
      data: {
        status: UpiHandleStatus.ACTIVE,
        linkedAccountEnc: encryptField(linked.accountNumber),
        linkedIfsc: linked.ifsc,
        linkedBankName: linked.bankName,
        verifiedAt: new Date(),
      },
    })
  }

  /**
   * Turn a handle off.
   *
   * DEACTIVATED, never deleted, and the row keeps its `vpa` forever. See the class
   * comment: reusing an address sends future payments to the wrong person.
   */
  async deactivate(userId: string, handleId: string): Promise<UpiHandle> {
    const handle = await this.owned(userId, handleId)

    const activeCount = await this.prisma.upiHandle.count({
      where: { userId, status: UpiHandleStatus.ACTIVE },
    })
    if (handle.status === UpiHandleStatus.ACTIVE && activeCount <= 1) {
      throw new ConflictException(
        'This is your only active UPI ID. Create another before turning this one off.',
      )
    }

    return this.prisma.upiHandle.update({
      where: { id: handle.id },
      data: {
        status: UpiHandleStatus.DEACTIVATED,
        deactivatedAt: new Date(),
        isPrimary: false,
      },
    })
  }

  async setPrimary(userId: string, handleId: string): Promise<UpiHandle> {
    const handle = await this.owned(userId, handleId)
    if (handle.status !== UpiHandleStatus.ACTIVE) {
      throw new ConflictException('Only an active UPI ID can be your primary')
    }

    // One statement per half, in a transaction, so there is never a moment with two
    // primaries or none — a request landing in between would resolve the wrong payee.
    const [, updated] = await this.prisma.$transaction([
      this.prisma.upiHandle.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.upiHandle.update({
        where: { id: handle.id },
        data: { isPrimary: true },
      }),
    ])
    return updated
  }

  /**
   * Resolve one of OUR addresses to its owner.
   *
   * Only ACTIVE handles resolve. A PENDING or DEACTIVATED handle returning a user would
   * let money settle internally to an address that is not supposed to receive it, and
   * for a deactivated one that means crediting a wallet the owner has moved on from.
   */
  async resolveInternal(
    vpa: string,
  ): Promise<{ userId: string; handle: UpiHandle } | null> {
    const parsed = parseVpa(vpa)
    if (!parsed || parsed.handle !== this.suffix()) return null

    const handle = await this.prisma.upiHandle.findUnique({
      where: { vpa: parsed.vpa },
    })
    if (!handle || handle.status !== UpiHandleStatus.ACTIVE) return null
    return { userId: handle.userId, handle }
  }

  /** The only projection of a linked account anyone sees. */
  describe(handle: UpiHandle): {
    id: string
    vpa: string
    status: UpiHandleStatus
    isPrimary: boolean
    linkedAccountMasked: string | null
    linkedIfsc: string | null
    linkedBankName: string | null
    verifiedAt: Date | null
  } {
    return {
      id: handle.id,
      vpa: handle.vpa,
      status: handle.status,
      isPrimary: handle.isPrimary,
      linkedAccountMasked: this.maskLinkedAccount(handle),
      linkedIfsc: handle.linkedIfsc,
      linkedBankName: handle.linkedBankName,
      verifiedAt: handle.verifiedAt,
    }
  }

  /**
   * `XXXX7890`, or null.
   *
   * A decrypt failure returns null instead of propagating. A rotated or misconfigured
   * encryption key must not make a user's wallet screen unreachable — they still need
   * to see their balance and their transactions, and the last four digits of a linked
   * account is the least important thing on the page.
   */
  private maskLinkedAccount(handle: UpiHandle): string | null {
    if (!handle.linkedAccountEnc) return null
    try {
      return maskAccount(decryptField(handle.linkedAccountEnc))
    } catch (error) {
      this.logger.error(
        `[${this.maskLinkedAccount.name}] Could not decrypt a linked account`,
        { handleId: handle.id, err: error },
      )
      return null
    }
  }

  private async owned(userId: string, handleId: string): Promise<UpiHandle> {
    const handle = await this.prisma.upiHandle.findFirst({
      where: { id: handleId, userId },
    })
    // A 404 rather than a 403: someone else's handle id must not be confirmed to exist.
    if (!handle) throw new NotFoundException('UPI ID not found')
    return handle
  }
}
