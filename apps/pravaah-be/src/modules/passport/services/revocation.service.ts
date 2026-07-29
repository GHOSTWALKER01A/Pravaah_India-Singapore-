import { Inject, Injectable, NotFoundException } from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { PASSPORT_ALG } from '@pravaah/schema'

import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CredentialStatus,
  type StatusList,
} from 'generated/prisma/client'

import { PassportConfig } from '@/modules/passport/passport.config'
import {
  nowSeconds,
  signCompactJws,
} from '@/modules/passport/crypto/jose.util'
import {
  STATUS_LIST_SIZE,
  STATUS_PURPOSE,
  createEmptyList,
  isRevokedInList,
  statusListSubject,
  withBit,
} from '@/modules/passport/crypto/status-list.util'
import { canTransition, isStatusListSet } from '@/modules/passport/passport.state'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'

/** A caller who does not know which list to use. There is only ever one active. */
const PRIMARY_LIST_SEQ = 1

export interface StatusAllocation {
  listId: string
  uri: string
  index: number
}

/**
 * Revocation via a W3C Bitstring Status List.
 *
 * Chosen over an "ask the issuer" endpoint for one reason that matters more than
 * any other: a verifier can cache the whole list and then check a credential with
 * NO network call and NO signal to us about who they are checking. A per-credential
 * status API would make Pravaah a surveillance point on every credit check its own
 * users submit — which would undo the privacy the credential exists to provide.
 */
@Injectable()
export class RevocationService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyManagementService,
    private readonly config: PassportConfig,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: RevocationService.name })
  }

  /**
   * Reserve the next index on the active list.
   *
   * The cursor is bumped with an atomic `increment` and the reserved index is
   * derived from the ROW RETURNED BY THAT UPDATE, so two concurrent issuances can
   * never receive the same index. The obvious alternative — `count()` the
   * credentials on the list — races on exactly that path and, worse, recycles an
   * index after any delete, which would silently transfer one credential's
   * revocation onto another.
   */
  async allocate(): Promise<StatusAllocation> {
    const list = await this.ensurePrimaryList()

    const updated = await this.prisma.statusList.update({
      where: { id: list.id },
      data: { nextIndex: { increment: 1 } },
      select: { id: true, uri: true, nextIndex: true, size: true },
    })
    // Post-increment value, so the index handed out is the pre-increment one.
    const index = updated.nextIndex - 1

    if (index >= updated.size) {
      // Running out is a capacity event, not a user error: 131,072 credentials
      // means it is time to publish a second list, and issuing beyond the list
      // would produce credentials that cannot be revoked.
      this.logger.error(
        `[${this.allocate.name}] Status list is full — a new list must be provisioned`,
        { listId: updated.id, size: updated.size },
      )
      throw new Error('Status list capacity exhausted')
    }

    return { listId: updated.id, uri: updated.uri, index }
  }

  /**
   * Set or clear one credential's bit and persist the credential's own status.
   *
   * Both happen in one transaction. A published list saying "revoked" while the
   * credential row says ISSUED (or the reverse) is the worst possible split: our
   * own admin console and every external verifier would disagree about whether a
   * passport works.
   */
  private async applyStatus(args: {
    credentialId: string
    next: CredentialStatus
    reason: string
    actorType: ActorType
    actorId?: string | null
    action: string
  }): Promise<{ status: CredentialStatus; changed: boolean }> {
    const credential = await this.prisma.credential.findUnique({
      where: { id: args.credentialId },
      include: { statusList: true },
    })
    if (!credential) throw new NotFoundException('Credential not found')

    if (credential.status === args.next) {
      // Idempotent: a double-tap on "revoke", or a scheduler racing a user, must
      // not produce a second audit entry or a spurious list version bump.
      return { status: credential.status, changed: false }
    }
    if (!canTransition(credential.status, args.next)) {
      this.logger.warn(
        `[${this.applyStatus.name}] Illegal credential transition refused`,
        {
          credentialId: credential.id,
          from: credential.status,
          to: args.next,
        },
      )
      return { status: credential.status, changed: false }
    }

    const shouldSet = isStatusListSet(args.next)
    const nextEncoded = withBit(
      credential.statusList.encodedList,
      credential.statusListIndex,
      shouldSet,
    )

    await this.prisma.$transaction([
      this.prisma.statusList.update({
        where: { id: credential.statusListId },
        data: {
          encodedList: nextEncoded,
          version: { increment: 1 },
          // The cached signature covers the OLD bitstring, so it is void the
          // moment a bit moves. Cleared here and re-minted lazily on the next
          // read, which keeps a revocation from waiting on a signing operation.
          signedJwt: null,
        },
      }),
      this.prisma.credential.update({
        where: { id: credential.id },
        data: {
          status: args.next,
          revokedAt:
            args.next === CredentialStatus.REVOKED ? new Date() : undefined,
          revokeReason: args.reason,
        },
      }),
    ])

    await this.audit.log({
      actorType: args.actorType,
      actorId: args.actorId ?? null,
      action: args.action,
      entity: 'Credential',
      entityId: credential.id,
      metadata: {
        credentialNumber: credential.credentialNumber,
        from: credential.status,
        to: args.next,
        reason: args.reason,
        statusListIndex: credential.statusListIndex,
      },
    })
    this.logger.warn(`[${this.applyStatus.name}] Credential status changed`, {
      credentialId: credential.id,
      from: credential.status,
      to: args.next,
      reason: args.reason,
    })

    return { status: args.next, changed: true }
  }

  /** Permanent revocation. Terminal — the user re-issues rather than un-revoking. */
  async revoke(
    credentialId: string,
    reason: string,
    actor: { type: ActorType; id?: string | null } = { type: ActorType.SYSTEM },
  ): Promise<{ status: CredentialStatus; changed: boolean }> {
    return this.applyStatus({
      credentialId,
      next: CredentialStatus.REVOKED,
      reason,
      actorType: actor.type,
      actorId: actor.id,
      action: 'passport.revoked',
    })
  }

  /**
   * Holder-initiated revocation, scoped to a credential they own.
   *
   * The ownership predicate is in the WHERE clause rather than a check after the read,
   * so a credential id belonging to somebody else is a 404 that reveals nothing about
   * whether it exists. Without this scoping, any authenticated user could revoke any
   * credential by id — the most damaging thing this API could get wrong.
   */
  async revokeOwned(
    userId: string,
    credentialId: string,
    reason: string,
    actor: { type: ActorType; id?: string | null },
  ): Promise<{ status: CredentialStatus; changed: boolean }> {
    const owned = await this.prisma.credential.findFirst({
      where: { id: credentialId, userId },
      select: { id: true },
    })
    if (!owned) throw new NotFoundException('Passport not found')
    return this.revoke(credentialId, reason, actor)
  }

  /** Reversible hold. Reads as "do not accept" to every verifier. */
  async suspend(
    credentialId: string,
    reason: string,
    actor: { type: ActorType; id?: string | null },
  ): Promise<{ status: CredentialStatus; changed: boolean }> {
    return this.applyStatus({
      credentialId,
      next: CredentialStatus.SUSPENDED,
      reason,
      actorType: actor.type,
      actorId: actor.id,
      action: 'passport.suspended',
    })
  }

  /** Lift a hold. Clears the bit, so the credential works again immediately. */
  async resume(
    credentialId: string,
    reason: string,
    actor: { type: ActorType; id?: string | null },
  ): Promise<{ status: CredentialStatus; changed: boolean }> {
    return this.applyStatus({
      credentialId,
      next: CredentialStatus.ISSUED,
      reason,
      actorType: actor.type,
      actorId: actor.id,
      action: 'passport.resumed',
    })
  }

  /**
   * Expire a credential.
   *
   * Deliberately does NOT set the status-list bit: expiry is already provable from
   * the `exp` claim inside the signed credential, so a verifier rejects it offline
   * with no list lookup at all. Burning a bit for a fact the credential already
   * carries would grow the list for nothing.
   */
  async expire(credentialId: string): Promise<{ changed: boolean }> {
    const result = await this.prisma.credential.updateMany({
      where: {
        id: credentialId,
        status: { in: [CredentialStatus.ISSUED, CredentialStatus.SUSPENDED] },
      },
      data: { status: CredentialStatus.EXPIRED },
    })
    return { changed: result.count > 0 }
  }

  /** Verifier-facing revocation check. */
  async isRevoked(uri: string, index: number): Promise<boolean> {
    const list = await this.prisma.statusList.findUnique({ where: { uri } })
    if (!list) {
      // A credential referencing a list we do not publish cannot be shown to be
      // live. Fail CLOSED — the alternative accepts any credential whose issuer
      // simply invented a status URI.
      this.logger.warn(
        `[${this.isRevoked.name}] Credential references an unknown status list`,
        { uri },
      )
      return true
    }
    return isRevokedInList(list.encodedList, index)
  }

  /**
   * Publish a list for verifiers.
   *
   * Returned as a SIGNED status-list credential, not a bare JSON body. Without a
   * signature, anyone able to intercept the response could un-revoke a stolen
   * credential by flipping one bit — and a verifier following a URL from inside a
   * credential has no other way to tell. The signature is minted lazily and cached
   * because a list is read constantly and written rarely.
   */
  async publish(listId: string): Promise<{
    uri: string
    version: number
    signedJwt: string
    credentialSubject: ReturnType<typeof statusListSubject>
    updatedAt: Date
  }> {
    const list = await this.findListBySeqOrId(listId)
    if (!list) throw new NotFoundException('Status list not found')

    const subject = statusListSubject({
      uri: list.uri,
      purpose: list.purpose,
      encodedList: list.encodedList,
    })

    if (list.signedJwt) {
      return {
        uri: list.uri,
        version: list.version,
        signedJwt: list.signedJwt,
        credentialSubject: subject,
        updatedAt: list.updatedAt,
      }
    }

    const { kid, keyId, privateKey } = await this.keys.activeSigningKey()
    const issuedAt = nowSeconds()
    const signedJwt = signCompactJws({
      header: { alg: PASSPORT_ALG, typ: 'JWT', kid },
      payload: {
        iss: this.config.did(),
        sub: subject.id,
        iat: issuedAt,
        // A short expiry is the freshness contract with a caching verifier: it
        // tells them how stale their cached list may be, and an expired list must
        // be refetched rather than trusted indefinitely.
        exp: issuedAt + 24 * 60 * 60,
        vc: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          type: ['VerifiableCredential', 'BitstringStatusListCredential'],
          issuer: this.config.did(),
          credentialSubject: subject,
        },
      },
      privateKey,
    })

    const saved = await this.prisma.statusList.update({
      where: { id: list.id },
      data: { signedJwt, issuerKeyId: keyId },
    })
    return {
      uri: saved.uri,
      version: saved.version,
      signedJwt,
      credentialSubject: subject,
      updatedAt: saved.updatedAt,
    }
  }

  /**
   * Create the primary list on first use.
   *
   * The `catch`-then-refetch handles two workers bootstrapping at once: the unique
   * constraint on `uri` makes one of them lose the insert, and losing it is fine —
   * the winner's list is the one both should use.
   */
  private async ensurePrimaryList(): Promise<StatusList> {
    const uri = this.config.statusListUri(PRIMARY_LIST_SEQ)
    const existing = await this.prisma.statusList.findUnique({ where: { uri } })
    if (existing) return existing

    try {
      const created = await this.prisma.statusList.create({
        data: {
          uri,
          purpose: STATUS_PURPOSE.REVOCATION,
          encodedList: createEmptyList(STATUS_LIST_SIZE),
          size: STATUS_LIST_SIZE,
        },
      })
      this.logger.info(
        `[${this.ensurePrimaryList.name}] Provisioned the primary status list`,
        { uri, size: STATUS_LIST_SIZE },
      )
      return created
    } catch {
      const raced = await this.prisma.statusList.findUnique({ where: { uri } })
      if (raced) return raced
      throw new Error('Could not provision a revocation status list')
    }
  }

  /**
   * Look up a list by its public sequence number ("1", from the URL) or its UUID.
   *
   * The URL carries the short sequence so the status URI stays human-readable and
   * stable, but internal callers hold the UUID — accepting both keeps a single
   * lookup path instead of two nearly-identical ones.
   */
  private async findListBySeqOrId(listId: string): Promise<StatusList | null> {
    const bySeq = await this.prisma.statusList.findUnique({
      where: { uri: this.config.statusListUri(listId) },
    })
    if (bySeq) return bySeq
    // Not a UUID (e.g. "2" for a list that does not exist) — skip the id lookup
    // rather than let Prisma raise on a malformed uuid.
    if (!/^[0-9a-f-]{36}$/i.test(listId)) return null
    return this.prisma.statusList.findUnique({ where: { id: listId } })
  }
}
