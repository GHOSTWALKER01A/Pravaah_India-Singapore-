import { z } from 'zod'

/**
 * M3 · Passport (Verifiable Credential layer) enums. Each mirrors a Prisma enum
 * so the RN wallet, the partner console, and the backend validate against one
 * source of truth.
 */

/** Credential lifecycle. Mirrors the Prisma `CredentialStatus` enum. */
export const CREDENTIAL_STATUS = {
  ISSUED: 'ISSUED',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const

export const CredentialStatusSchema = z.enum([
  CREDENTIAL_STATUS.ISSUED,
  CREDENTIAL_STATUS.SUSPENDED,
  CREDENTIAL_STATUS.REVOKED,
  CREDENTIAL_STATUS.EXPIRED,
])
export type CredentialStatusInput = z.infer<typeof CredentialStatusSchema>

/** How a presentation reached the verifier. */
export const PRESENTATION_CHANNEL = {
  QR: 'QR',
  NFC: 'NFC',
  DEEPLINK: 'DEEPLINK',
  API: 'API',
} as const

export const PresentationChannelSchema = z.enum([
  PRESENTATION_CHANNEL.QR,
  PRESENTATION_CHANNEL.NFC,
  PRESENTATION_CHANNEL.DEEPLINK,
  PRESENTATION_CHANNEL.API,
])
export type PresentationChannelInput = z.infer<
  typeof PresentationChannelSchema
>

/** Physical companion card lifecycle. */
export const CARD_STATUS = {
  ACTIVE: 'ACTIVE',
  LOST: 'LOST',
  REVOKED: 'REVOKED',
} as const

export const CardStatusSchema = z.enum([
  CARD_STATUS.ACTIVE,
  CARD_STATUS.LOST,
  CARD_STATUS.REVOKED,
])
export type CardStatusInput = z.infer<typeof CardStatusSchema>

/**
 * A verifier's request for claims — the holder-approval handshake behind a card
 * tap or a QR scan.
 *
 *   PENDING   verifier asked, holder has not seen it yet
 *   APPROVED  holder ticked claims and signed a KB-JWT; a presentation exists
 *   DECLINED  holder refused (an explicit "no", not a timeout)
 *   EXPIRED   the nonce aged out before the holder acted
 *   CONSUMED  the verifier collected the result; the nonce is now burnt
 */
export const VERIFIER_REQUEST_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  CONSUMED: 'CONSUMED',
} as const

export const VerifierRequestStatusSchema = z.enum([
  VERIFIER_REQUEST_STATUS.PENDING,
  VERIFIER_REQUEST_STATUS.APPROVED,
  VERIFIER_REQUEST_STATUS.DECLINED,
  VERIFIER_REQUEST_STATUS.EXPIRED,
  VERIFIER_REQUEST_STATUS.CONSUMED,
])
export type VerifierRequestStatusInput = z.infer<
  typeof VerifierRequestStatusSchema
>

/**
 * The credential type URI (`vct`). A verifier keys its claim expectations off
 * this, so it is a versioned, permanent identifier: a breaking change to the
 * claim set mints a `...-v2`, it never re-defines this one.
 */
export const PASSPORT_VCT_PATH =
  '/credentials/financial-reputation-passport/v1'

/** `document_type`, mirroring an ICAO 9303 document code. */
export const PASSPORT_DOCUMENT_TYPE = 'FINANCIAL_REPUTATION_PASSPORT'

/** `issuing_authority` — the "State" in ICAO terms. */
export const PASSPORT_ISSUING_AUTHORITY = 'PRAVAAH'

/**
 * The SD-JWT VC media type from the IETF spec (`dc+sd-jwt`), used as the JWS
 * `typ`. A verifier that does not recognise it MUST reject the token rather than
 * treat it as a plain JWT — which is the whole point of typing it.
 */
export const SD_JWT_VC_TYP = 'dc+sd-jwt'

/** The `typ` of a holder Key Binding JWT. */
export const KB_JWT_TYP = 'kb+jwt'

/** The only signature algorithm we issue or accept. */
export const PASSPORT_ALG = 'ES256'

/** Separator between the SD-JWT, its disclosures, and the KB-JWT. */
export const SD_JWT_SEPARATOR = '~'
