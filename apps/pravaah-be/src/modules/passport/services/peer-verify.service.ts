import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import {
  CLAIM_CATALOGUE,
  PRESENTATION_TEMPLATES,
  isPeerAudience,
  normalizePravaahId,
  peerAudience,
  type DisclosableClaim,
  type PeerScanDto,
} from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'
import { PushService } from '@/modules/notifications/push.service'

import {
  ActorType,
  CardStatus,
  CredentialStatus,
  VerifierRequestStatus,
} from 'generated/prisma/client'

import { PassportConfig } from '@/modules/passport/passport.config'
import { splitVerifiedName } from '@/modules/passport/passport.state'

import { randomBytes } from 'node:crypto'

/** 256 bits of challenge, matching the partner path. A guessable nonce is no defence. */
const NONCE_BYTES = 32

/**
 * The peer check has ONE template and it is not a parameter.
 *
 * A partner names the template it wants, because a lender and a landlord genuinely need
 * different things and both are accountable for asking. A person scanning in the street
 * is neither — so letting the scanner choose would mean any user could aim
 * `CROSS_BORDER_RENTAL` at a stranger and ask for their passport number. Pinning it makes
 * the ceiling of a peer scan a property of the SYSTEM rather than of whoever is holding
 * the phone.
 */
const PEER_TEMPLATE = PRESENTATION_TEMPLATES.PEER_INTRODUCTION

/**
 * Person-to-person verification.
 *
 * ── What this is ──
 * The partner path assumes an institution: an API key, a registered audience, a contract.
 * This is the same handshake between two people who have never met, where the "verifier"
 * is just another holder with a camera. Everything M3 already guarantees still has to
 * hold — issuer signature, revocation, selective disclosure, key binding, replay defence —
 * and the only thing that changes is who the audience is.
 *
 * ── The order of events, which IS the privacy property ──
 *
 *   1. A scans B's code       → a request is opened. A learns NOTHING. Not B's name,
 *                               not that B exists, not whether the code was even B's.
 *   2. B is asked             → B sees who A is (name, country) and exactly what A would
 *                               see, and starts from every box unticked.
 *   3. B approves             → B's device signs a KB-JWT over A's nonce and A's audience.
 *   4. A collects             → A receives only the claims B ticked.
 *
 * Step 1 returning nothing is the whole design. A flow that showed A anything before step
 * 3 would have already disclosed it, and the approval would be theatre.
 *
 * ── Why the scanner needs an audience ──
 * See `peer.schema.ts`. In short: the KB-JWT is made out to one audience, and that is what
 * stops a presentation captured here being replayed at a lender. A peer's audience is
 * their own Pravaah ID under a reserved scheme, so it is stable, public, checksum-guarded,
 * and cannot collide with a partner's.
 */
@Injectable()
export class PeerVerifyService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PassportConfig,
    private readonly push: PushService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PeerVerifyService.name })
  }

  // ── 1. A scans B's code ───────────────────────────────────────────────────
  /**
   * Resolve a scanned string and, if it is one of ours, ask its holder.
   *
   * Returns `NOT_PASSPORT` rather than throwing when the payload is not a Pravaah code:
   * the scanner is a general-purpose camera that also reads payment QRs, and a 400 here
   * would make "this is a UPI code, not a passport" indistinguishable from a real failure.
   */
  async scan(
    scannerUserId: string,
    dto: PeerScanDto,
  ): Promise<Record<string, unknown>> {
    const cardRef = this.cardRefFrom(dto.payload)
    if (!cardRef) return { kind: 'NOT_PASSPORT' }

    const scanner = await this.prisma.user.findUnique({
      where: { id: scannerUserId },
      select: { id: true, pravaahId: true, kycStatus: true },
    })
    /**
     * The scanner must be identifiable before anybody is asked about them.
     *
     * Not gatekeeping for its own sake: the audience IS the Pravaah ID, so a user without
     * one cannot be bound into a KB-JWT at all — and the holder would be asked to approve
     * a request from nobody in particular, which is not a decision anyone can make.
     */
    const audience = scanner?.pravaahId ? peerAudience(scanner.pravaahId) : null
    if (!audience) {
      throw new ForbiddenException(
        'Your own Pravaah ID is still being set up. Try again in a moment.',
      )
    }

    const card = await this.prisma.passportCard.findUnique({
      where: { qrPayloadRef: cardRef },
      select: {
        userId: true,
        credentialId: true,
        status: true,
        cardSerial: true,
      },
    })
    // An unrecognised reference is reported as "not one of ours" rather than "no such
    // card", so a scanner cannot walk the reference space to learn which codes exist.
    if (!card) return { kind: 'NOT_PASSPORT' }
    if (card.status !== CardStatus.ACTIVE) {
      throw new ForbiddenException(
        'This passport code has been switched off by its owner.',
      )
    }

    /**
     * Scanning your own code is refused, and explicitly.
     *
     * It would otherwise open a request the same person is then asked to approve — a
     * self-presentation with a self-audience, which pollutes their own share history with
     * an entry that means nothing and could be used to manufacture "verifications".
     */
    if (card.userId === scannerUserId) {
      throw new BadRequestException('That is your own passport code.')
    }

    const holder = await this.prisma.user.findUnique({
      where: { id: card.userId },
      select: { id: true, isSuspended: true, expoPushToken: true },
    })
    if (!holder || holder.isSuspended) {
      throw new ForbiddenException(
        'This passport cannot be checked at the moment.',
      )
    }

    /**
     * One open question per pair at a time.
     *
     * Without this, a scanner tapping twice — or a camera firing on two frames — leaves
     * the holder with a stack of identical prompts and no way to tell which one the person
     * in front of them is waiting on. The existing PENDING request is returned instead,
     * so a retry rejoins the conversation rather than starting a second one.
     */
    const open = await this.prisma.verifierRequest.findFirst({
      where: {
        userId: card.userId,
        requestedByUserId: scannerUserId,
        status: VerifierRequestStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (open) {
      return {
        kind: 'PASSPORT',
        requestId: open.id,
        status: open.status,
        expiresAt: open.expiresAt,
        requestedClaims: open.requestedClaims,
        purpose: open.purpose,
        resumed: true,
      }
    }

    const request = await this.prisma.verifierRequest.create({
      data: {
        // No partner: this is a person. `partnerId` staying null is also what the
        // result read keys off to know it must be scoped to the SCANNER instead.
        partnerId: null,
        requestedByUserId: scannerUserId,
        audience,
        purpose: PEER_TEMPLATE.purpose,
        template: PEER_TEMPLATE.id,
        requestedClaims: [...PEER_TEMPLATE.claims],
        nonce: randomBytes(NONCE_BYTES).toString('base64url'),
        channel: 'QR',
        status: VerifierRequestStatus.PENDING,
        userId: card.userId,
        credentialId: card.credentialId,
        cardRef,
        expiresAt: new Date(Date.now() + dto.ttlSeconds * 1000),
      },
    })

    await this.notifyHolder(holder.expoPushToken, scannerUserId, request.id)

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: scannerUserId,
      action: 'passport.peer_scan',
      entity: 'VerifierRequest',
      entityId: request.id,
      metadata: {
        holderId: card.userId,
        cardSerial: card.cardSerial,
        template: PEER_TEMPLATE.id,
        // The reference itself is not logged: an audit reader holding it could open
        // requests against the holder.
      },
    })
    this.logger.info(`[${this.scan.name}] Peer scan opened a request`, {
      requestId: request.id,
      scannerUserId,
    })

    return {
      kind: 'PASSPORT',
      requestId: request.id,
      status: request.status,
      expiresAt: request.expiresAt,
      requestedClaims: request.requestedClaims,
      purpose: request.purpose,
      resumed: false,
    }
  }

  // ── 4. A collects ─────────────────────────────────────────────────────────
  /**
   * The scanner's poll.
   *
   * Scoped to `requestedByUserId`, which is the peer equivalent of the partner path's
   * `partnerId` check: a request id must never be a way for one person to read the result
   * of somebody else's check. A mismatch is a 404 rather than a 403, so the id space
   * cannot be probed for which requests exist.
   *
   * Idempotent by construction — the verdict was computed once at approval time and is
   * returned from `resultJson`, so a dropped connection cannot produce a second,
   * differently-timed answer.
   */
  async result(
    scannerUserId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const request = await this.prisma.verifierRequest.findUnique({
      where: { id: requestId },
      include: {
        user: { select: { primaryCountry: true } },
      },
    })
    if (!request || request.requestedByUserId !== scannerUserId) {
      throw new NotFoundException('Request not found')
    }

    if (
      request.status === VerifierRequestStatus.PENDING &&
      request.expiresAt <= new Date()
    ) {
      await this.prisma.verifierRequest.update({
        where: { id: request.id },
        data: { status: VerifierRequestStatus.EXPIRED },
      })
      return {
        requestId: request.id,
        status: VerifierRequestStatus.EXPIRED,
        message: 'They did not answer in time. Ask them to show the code again.',
      }
    }

    if (
      request.status === VerifierRequestStatus.APPROVED ||
      request.status === VerifierRequestStatus.CONSUMED
    ) {
      if (request.status === VerifierRequestStatus.APPROVED) {
        await this.prisma.verifierRequest.update({
          where: { id: request.id },
          data: {
            status: VerifierRequestStatus.CONSUMED,
            consumedAt: new Date(),
          },
        })
      }
      return {
        requestId: request.id,
        status: VerifierRequestStatus.CONSUMED,
        result: request.resultJson,
      }
    }

    return {
      requestId: request.id,
      status: request.status,
      message:
        request.status === VerifierRequestStatus.DECLINED
          ? 'They chose not to share.'
          : 'Waiting for them to approve on their phone.',
    }
  }

  /** Give up on a request the scanner no longer needs. Frees the holder's prompt. */
  async cancel(scannerUserId: string, requestId: string): Promise<{ status: string }> {
    const result = await this.prisma.verifierRequest.updateMany({
      where: {
        id: requestId,
        requestedByUserId: scannerUserId,
        status: VerifierRequestStatus.PENDING,
      },
      data: { status: VerifierRequestStatus.EXPIRED },
    })
    if (result.count === 0) throw new NotFoundException('Request not found')
    return { status: VerifierRequestStatus.EXPIRED }
  }

  // ── the holder's side: who is asking ──────────────────────────────────────
  /**
   * Describe the scanner to the holder who is about to answer them.
   *
   * The MINIMUM that makes consent real: a name and a country, so the holder can match the
   * prompt to the person standing in front of them. Deliberately not the scanner's score,
   * their Pravaah ID, or whether they are verified — a request to see somebody's
   * reputation is not itself a reason to disclose the asker's.
   *
   * The name comes from the scanner's own VERIFIED KYC name, never from anything they
   * typed. A self-declared display name on this screen would be a free impersonation
   * primitive: "Approve — asked by <the name of someone you trust>".
   */
  async describeRequester(
    requestedByUserId: string | null,
  ): Promise<Record<string, unknown> | null> {
    if (!requestedByUserId) return null
    const scanner = await this.prisma.user.findUnique({
      where: { id: requestedByUserId },
      select: {
        primaryCountry: true,
        kycStatus: true,
        kycProfile: { select: { verifiedName: true } },
      },
    })
    if (!scanner) return null

    const verifiedName = scanner.kycProfile?.verifiedName ?? null
    const { givenName, familyName } = splitVerifiedName(verifiedName)
    return {
      /**
       * Null when the scanner has not completed KYC. Rendered as "an unverified
       * Pravaah user", which is a far more useful thing for the holder to know than a
       * name would have been — it is the single strongest reason to decline.
       */
      name: verifiedName,
      givenName: givenName || null,
      familyName: familyName || null,
      country: scanner.primaryCountry,
      identityVerified: scanner.kycStatus === 'VERIFIED',
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  /**
   * Pull a card reference out of whatever the camera read.
   *
   * Matches the ONE form a Pravaah passport code is ever emitted in: a `…/verify/card/<ref>`
   * URL, with or without a scheme, query or trailing slash. Matching on the PATH rather than
   * the host is deliberate — the public URL is an ngrok tunnel in development and a real
   * domain in production, and a host check would make every demo code unscannable.
   *
   * ── Why a bare reference is NOT accepted ──
   * An earlier version also took a naked `[A-Za-z0-9_-]{20,44}` token, on the theory that an
   * NFC tag or a typed code might carry the reference without the URL around it. Two things
   * were wrong with that. Nothing in the system produces one — `CardService` writes
   * `nfcPayload: card.verifyUrl`, the same string as the QR — so it accepted input that does
   * not exist. And it is genuinely ambiguous with a real payment code: the spec caught an
   * EMVCo payload (`00020101021226580014A00000052401…`) being classified as a passport,
   * which would have sent every such scan through this reader for nothing. Narrower is
   * correct here, and the test that found it is pinned.
   *
   * A reference that matches structurally is still only a lookup key; it proves nothing
   * until the row behind it is found and its status checked.
   */
  private cardRefFrom(payload: string): string | null {
    const url = /\/verify\/card\/([A-Za-z0-9_-]{16,64})\/?(?:[?#].*)?$/.exec(
      payload.trim(),
    )
    return url ? url[1]! : null
  }

  /**
   * Tell the holder somebody is waiting.
   *
   * Fire-and-forget. A push that fails must not fail the scan: the holder's wallet polls
   * its inbox anyway, so the notification is a latency improvement rather than the
   * delivery mechanism. Treating it as load-bearing would make a peer check impossible
   * for anyone in Expo Go, on a simulator, or with notifications switched off.
   *
   * The body deliberately does not name the scanner. A lock-screen preview is visible to
   * whoever is holding the phone — including, at a counter, the person who just scanned.
   */
  private async notifyHolder(
    token: string | null,
    scannerUserId: string,
    requestId: string,
  ): Promise<void> {
    if (!token) return
    const requester = await this.describeRequester(scannerUserId)
    void this.push
      .send({
        token,
        title: 'Someone is asking to check your passport',
        body: requester?.identityVerified
          ? 'Open Pravaah to see who is asking and what they would see.'
          : 'Open Pravaah — the person asking has not verified their identity.',
        data: {
          kind: 'passport.peer_request',
          requestId,
          // The deep link the app already resolves for a card tap, so a peer request
          // lands on the same consent screen rather than a second one.
          url: this.config.walletRequestLink(requestId),
        },
      })
      .catch(() => undefined)
  }

  /**
   * Turn a peer audience back into the Pravaah ID it names.
   *
   * Used by the share-history renderer so "who saw my score" reads as a person rather than
   * as `pravaah:peer:PVH-…`. Re-normalised on the way out — see `peerAudienceHolder`.
   */
  static isPeer(audience: string): boolean {
    return isPeerAudience(audience)
  }

  /** Claim labels for the scanner's result view, so it renders sentences not keys. */
  static labelsFor(claims: string[]): Record<string, string> {
    return Object.fromEntries(
      claims
        .filter((claim): claim is DisclosableClaim => claim in CLAIM_CATALOGUE)
        .map((claim) => [claim, CLAIM_CATALOGUE[claim].label]),
    )
  }

  /** Exposed for the controller's own validation of a typed Pravaah ID. */
  static canonicalId(raw: string): string | null {
    return normalizePravaahId(raw)
  }

  /** Present a credential's live state to the scanner, without naming the holder. */
  async credentialStillLive(credentialId: string | null): Promise<boolean> {
    if (!credentialId) return false
    const credential = await this.prisma.credential.findUnique({
      where: { id: credentialId },
      select: { status: true, expiresAt: true },
    })
    return (
      !!credential &&
      credential.status === CredentialStatus.ISSUED &&
      credential.expiresAt > new Date()
    )
  }
}
