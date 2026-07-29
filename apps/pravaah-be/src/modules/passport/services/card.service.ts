import { randomBytes } from 'node:crypto'

import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'

import { decryptField } from '@/common/crypto/field-crypto.util'
import { AuditService } from '@/modules/audit/audit.service'
import { PrismaService } from '@/modules/database/prisma/prisma.service'

import {
  ActorType,
  CardStatus,
  CredentialStatus,
  ScoreBand,
} from 'generated/prisma/client'

import { PassportConfig } from '@/modules/passport/passport.config'
import { textToQrSvg } from '@/modules/passport/crypto/qr.util'
import { parseDisclosure } from '@/modules/passport/crypto/sd-jwt.util'
import {
  encodeTd1Mrz,
  icaoStateCode,
  mrzDocumentNumber,
} from '@/modules/passport/icao.util'
import { RevocationService } from '@/modules/passport/services/revocation.service'

/** 128 bits, base64url — 22 characters, short enough to print legibly. */
const CARD_REF_BYTES = 16

/**
 * Card-face colours, from the M3 design spec (§14.4). Kept here rather than in the
 * client so the printed card, the wallet's rendering, and the console's artwork are
 * the same object rather than three that drift.
 */
const CARD_PALETTE = {
  base: '#0B1F3A',
  baseGradientEnd: '#14335F',
  saffron: '#FF9A3D',
  teal: '#0FB39A',
  gold: '#C9A227',
  text: '#F5F7FA',
  muted: '#9FB3C8',
} as const

/** Band accent, so the tier badge reads at a glance without printing a number. */
const BAND_ACCENT: Record<ScoreBand, string> = {
  EXCELLENT: '#2ECC71',
  VERY_GOOD: '#27AE60',
  GOOD: '#F1C40F',
  FAIR: '#E67E22',
  POOR: '#E74C3C',
}

/**
 * The physical companion card.
 *
 * ISO/IEC 7810 ID-1 — 85.6 × 54 mm, the size of a bank card, which is also ICAO's
 * TD1 travel-document format. That coincidence is the point: TD1 is the correct
 * international form factor for an identity document, so a card that mirrors it is
 * standards-aligned rather than merely card-shaped.
 *
 * THE SECURITY MODEL, which everything here follows from: the card carries a
 * REFERENCE, never the credential. Tapping it, photographing its QR, or stealing it
 * outright yields an opaque token that can only open a request the holder's own
 * device must approve and sign. A card is therefore not a bearer instrument, and
 * losing one is an inconvenience rather than a breach.
 *
 * A real secure-element chip (eMRTD-grade, with PACE) needs a personalisation
 * bureau and certificates, so it is roadmap. Printed + NFC-tag is what is buildable
 * now, and the reference-token model is what makes that safe.
 */
@Injectable()
export class CardService {
  private readonly logger: AppLogger

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PassportConfig,
    private readonly revocation: RevocationService,
    private readonly audit: AuditService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: CardService.name })
  }

  /**
   * Issue or re-point the holder's card.
   *
   * A card belongs to the PERSON, not to one credential. Refreshing a score mints a
   * new credential, and the plastic already in someone's wallet has to keep working
   * — so an existing card is re-pointed and its printed reference, serial and MRZ
   * are preserved. Minting a new reference on every re-issue would brick the card in
   * their hand.
   */
  async ensureCard(userId: string): Promise<Record<string, unknown>> {
    const credential = await this.prisma.credential.findFirst({
      where: {
        userId,
        status: CredentialStatus.ISSUED,
        expiresAt: { gt: new Date() },
      },
      orderBy: { issuedAt: 'desc' },
    })
    if (!credential) {
      throw new ForbiddenException(
        'Issue your passport before requesting a card',
      )
    }

    const existing = await this.prisma.passportCard.findUnique({
      where: { userId },
    })

    if (existing) {
      if (existing.status === CardStatus.REVOKED) {
        throw new ForbiddenException(
          'This card has been cancelled. Contact support for a replacement.',
        )
      }

      /**
       * A LOST card is replaced, not re-pointed.
       *
       * Its printed reference is compromised — that is what "lost" means — so re-pointing
       * would hand a working URL back to whoever picked the card up. A fresh reference and
       * serial are minted instead, and the old plastic stays dead.
       *
       * Without this branch, reporting a card lost and then re-issuing left the holder
       * permanently unable to obtain a working card: the row existed, so no new one was
       * created, and its LOST status meant every payload came back with a null verify URL.
       */
      if (existing.status === CardStatus.LOST) {
        return this.mintCard(userId, credential.id, {
          replacing: existing.cardSerial,
        })
      }

      const repointed =
        existing.credentialId === credential.id
          ? existing
          : await this.prisma.passportCard.update({
              where: { userId },
              data: { credentialId: credential.id },
            })
      if (repointed.credentialId !== existing.credentialId) {
        this.logger.info(
          `[${this.ensureCard.name}] Card re-pointed to the refreshed credential`,
          { userId, credentialId: credential.id },
        )
      }
      return this.present(repointed, {
        scoreBand: credential.scoreBand,
        credentialNumber: credential.credentialNumber,
        expiresAt: credential.expiresAt,
      })
    }

    return this.mintCard(userId, credential.id)
  }

  /**
   * Create (or replace) the holder's card row.
   *
   * `upsert` on `userId` rather than `create`, because a replacement writes over the LOST
   * row: the card belongs to the person and there is only ever one, so a second row would
   * violate the unique key and a delete-then-create would lose the audit link.
   */
  private async mintCard(
    userId: string,
    credentialId: string,
    opts: { replacing?: string } = {},
  ): Promise<Record<string, unknown>> {
    const credential = await this.prisma.credential.findUniqueOrThrow({
      where: { id: credentialId },
      select: { credentialNumber: true, scoreBand: true, expiresAt: true },
    })

    const cardRef = randomBytes(CARD_REF_BYTES).toString('base64url')
    const mrz = await this.buildMrz(credentialId)
    // A replacement gets a distinguishable serial, so a support conversation about "my
    // card" is never ambiguous between the dead one and the live one.
    const cardSerial = opts.replacing
      ? `CARD-${credential.credentialNumber}-R${Date.now().toString(36).slice(-4).toUpperCase()}`
      : `CARD-${credential.credentialNumber}`

    const data = {
      credentialId,
      cardSerial,
      qrPayloadRef: cardRef,
      verifyUrl: this.config.cardVerifyUrl(cardRef),
      mrzLine1: mrz.line1,
      mrzLine2: mrz.line2,
      mrzLine3: mrz.line3,
      status: CardStatus.ACTIVE,
      nfcWritten: false,
      lastVerifiedAt: null,
    }

    const card = await this.prisma.passportCard.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    })

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: opts.replacing
        ? 'passport.card_replaced'
        : 'passport.card_issued',
      entity: 'PassportCard',
      entityId: card.id,
      metadata: {
        cardSerial: card.cardSerial,
        credentialId,
        replacing: opts.replacing ?? null,
        // The reference is deliberately NOT logged: an audit reader holding it could open
        // verify requests against the holder.
      },
    })
    this.logger.info(
      `[${this.mintCard.name}] ${opts.replacing ? 'Replacement card' : 'Card'} issued`,
      { userId, cardSerial: card.cardSerial },
    )

    return this.present(card, {
      scoreBand: credential.scoreBand,
      credentialNumber: credential.credentialNumber,
      expiresAt: credential.expiresAt,
    })
  }

  /** Record that the app successfully wrote the NFC tag. */
  async markNfcWritten(userId: string): Promise<{ nfcWritten: boolean }> {
    const card = await this.prisma.passportCard.findUnique({
      where: { userId },
    })
    if (!card) throw new NotFoundException('No card on file')
    await this.prisma.passportCard.update({
      where: { userId },
      data: { nfcWritten: true },
    })
    return { nfcWritten: true }
  }

  /**
   * Report a card lost.
   *
   * Two things happen, and both are needed. The card is marked LOST so its reference
   * stops resolving — that alone is enough, because the reference is all the card
   * holds. The credential is ALSO revoked, because a user reporting a lost card is
   * usually reporting a lost wallet, and their phone may have gone with it. Killing
   * the credential is the conservative reading of an ambiguous signal, and a re-issue
   * costs the user one tap.
   */
  async reportLost(userId: string): Promise<Record<string, unknown>> {
    const card = await this.prisma.passportCard.findUnique({
      where: { userId },
      include: { credential: { select: { id: true, status: true } } },
    })
    if (!card) throw new NotFoundException('No card on file')

    await this.prisma.passportCard.update({
      where: { userId },
      data: { status: CardStatus.LOST, credentialId: null },
    })

    let credentialRevoked = false
    if (
      card.credential &&
      (card.credential.status === CredentialStatus.ISSUED ||
        card.credential.status === CredentialStatus.SUSPENDED)
    ) {
      const result = await this.revocation.revoke(
        card.credential.id,
        'card_reported_lost',
        { type: ActorType.USER, id: userId },
      )
      credentialRevoked = result.changed
    }

    await this.audit.log({
      actorType: ActorType.USER,
      actorId: userId,
      action: 'passport.card_lost',
      entity: 'PassportCard',
      entityId: card.id,
      metadata: { cardSerial: card.cardSerial, credentialRevoked },
    })
    this.logger.warn(`[${this.reportLost.name}] Card reported lost`, {
      userId,
      cardSerial: card.cardSerial,
      credentialRevoked,
    })

    return {
      status: CardStatus.LOST,
      credentialRevoked,
      message: credentialRevoked
        ? 'Your card is disabled and your passport has been revoked. Issue a new passport when you are ready.'
        : 'Your card is disabled and can no longer be used.',
    }
  }

  /** The holder's card, or null when they have none. */
  async forHolder(userId: string): Promise<Record<string, unknown> | null> {
    const card = await this.prisma.passportCard.findUnique({
      where: { userId },
      include: {
        credential: {
          select: { scoreBand: true, credentialNumber: true, expiresAt: true },
        },
      },
    })
    return card ? this.present(card, card.credential) : null
  }

  /**
   * Client-facing card payload plus print-ready artwork data.
   *
   * The QR is rendered server-side as an SVG so the wallet, the console, and the
   * print vendor all draw the same symbol from one encoder — three independent QR
   * implementations is three chances for a card that scans in one place and not
   * another.
   */
  private present(
    card: {
      cardSerial: string
      qrPayloadRef: string
      verifyUrl: string
      mrzLine1: string
      mrzLine2: string
      mrzLine3: string
      nfcWritten: boolean
      status: CardStatus
      issuedAt: Date
      lastVerifiedAt: Date | null
    },
    /**
     * The credential the card resolves to.
     *
     * The card FACE prints the credential number and the expiry, so they belong in this
     * payload rather than being derived client-side. Deriving the number by stripping the
     * `CARD-` prefix off the serial looks like it works and silently breaks on a replacement
     * card, whose serial carries an `-R…` suffix the credential number never had.
     *
     * Null when the card has been reported lost: it points at no credential any more.
     */
    credential: {
      scoreBand: ScoreBand | null
      credentialNumber: string
      expiresAt: Date
    } | null,
  ): Record<string, unknown> {
    const scoreBand = credential?.scoreBand ?? null
    const usable = card.status === CardStatus.ACTIVE
    return {
      cardSerial: card.cardSerial,
      status: card.status,
      nfcWritten: card.nfcWritten,
      issuedAt: card.issuedAt,
      lastVerifiedAt: card.lastVerifiedAt,
      // A disabled card must not hand out a working URL, whatever the client does
      // with it. Withheld here rather than relying on the resolve endpoint to refuse.
      verifyUrl: usable ? card.verifyUrl : null,
      /** Identical payload for the QR and the NFC tag — one thing to get right. */
      nfcPayload: usable ? card.verifyUrl : null,
      qrSvg: usable
        ? textToQrSvg(card.verifyUrl, {
            moduleSize: 6,
            dark: CARD_PALETTE.base,
          })
        : null,
      // What the card face prints, alongside the machine-readable zone.
      credentialNumber: credential?.credentialNumber ?? null,
      expiresAt: credential?.expiresAt ?? null,
      mrz: {
        line1: card.mrzLine1,
        line2: card.mrzLine2,
        line3: card.mrzLine3,
      },
      artwork: {
        palette: CARD_PALETTE,
        bandAccent: scoreBand ? BAND_ACCENT[scoreBand] : CARD_PALETTE.muted,
        // The BAND, never the number. A card is a physical object that gets left on
        // desks and photographed; printing an exact score on it would leak the one
        // figure the credential goes to such lengths to keep selective.
        band: scoreBand,
        dimensionsMm: { width: 85.6, height: 54, cornerRadius: 3.18 },
        title: 'FINANCIAL REPUTATION PASSPORT',
        issuer: 'PRAVAAH',
      },
    }
  }

  /**
   * Build the printed TD1 zone from the credential's own disclosures.
   *
   * Read out of the credential rather than re-queried from the user table, so the
   * printed card and the signed credential cannot disagree: the card asserts what
   * the credential asserts, and nothing else.
   *
   * Name and nationality are read; birth date and sex are left as filler when the
   * credential does not carry them, which produces a valid MRZ for a document that
   * simply does not assert age — the honest encoding, rather than a fabricated date.
   */
  private async buildMrz(credentialId: string): Promise<{
    line1: string
    line2: string
    line3: string
  }> {
    const credential = await this.prisma.credential.findUniqueOrThrow({
      where: { id: credentialId },
      include: { user: { select: { primaryCountry: true } } },
    })

    const disclosures = JSON.parse(
      decryptField(credential.disclosuresEnc),
    ) as Record<string, string>
    const claim = (name: string): unknown => {
      const encoded = disclosures[name]
      return encoded ? parseDisclosure(encoded)?.value : undefined
    }

    const birthRaw = claim('birth_date')
    const birthDate =
      typeof birthRaw === 'string' && !Number.isNaN(Date.parse(birthRaw))
        ? new Date(birthRaw)
        : null
    const sexRaw = claim('sex')
    const sex =
      sexRaw === 'M' || sexRaw === 'F' ? (sexRaw as 'M' | 'F') : ('<' as const)

    return encodeTd1Mrz({
      // `IP` is the 9303 document code for an identity document that is not a
      // booklet passport — the correct code for a card of this kind.
      documentCode: 'IP',
      issuingState: icaoStateCode(credential.user.primaryCountry),
      documentNumber: mrzDocumentNumber(credential.credentialNumber),
      birthDate,
      sex,
      expiryDate: credential.expiresAt,
      nationality: icaoStateCode(credential.user.primaryCountry),
      familyName: String(claim('family_name') ?? ''),
      givenName: String(claim('given_name') ?? ''),
      // The optional-data fields carry what a reader most wants and neither leaks:
      // the band (not the score) and the model version that produced it.
      optionalData1: credential.scoreBand ?? '',
      optionalData2: '',
    })
  }
}
