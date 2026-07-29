import { z } from 'zod'

import { DisclosableClaimSchema } from '../schemas/claims.schema'
import { PresentationChannelSchema } from '../schemas/passport-enums.schema'

/** A compact JWS: three base64url segments. Used for the holder's KB-JWT. */
const CompactJws = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    'Expected a compact JWS (three base64url segments)',
  )
  .max(4096)

/**
 * Body for `POST /passport/present` — a direct presentation, where the holder
 * already knows the verifier's audience and nonce (an API integration, or the
 * verifier's own QR).
 *
 * The KB-JWT is signed ON DEVICE and passed in. The server never signs it: a
 * server-signed key binding proof would prove only that our server was online,
 * which is not a fact any verifier needs.
 */
export const PresentSchema = z.object({
  credentialId: z.uuid(),
  /**
   * Claims the holder ticked. May legitimately be EMPTY: presenting zero claims
   * still proves "PRAVAAH issued a live, unrevoked passport to the person holding
   * this device", which is a real assertion — and the most private one available.
   */
  revealClaims: z.array(DisclosableClaimSchema).max(32).default([]),
  /** The verifier's identifier — must equal the `aud` inside the KB-JWT. */
  verifier: z.string().trim().min(1).max(200),
  /** The verifier's challenge. Replay defence; must equal `nonce` in the KB-JWT. */
  nonce: z.string().trim().min(16).max(256),
  channel: PresentationChannelSchema.default('API'),
  kbJwt: CompactJws,
})
export type PresentDto = z.infer<typeof PresentSchema>

/**
 * Body for `POST /passport/requests/:requestId/approve` — the holder answering a
 * verifier request raised by a card tap, a QR scan, or a partner API call.
 *
 * The audience and nonce are NOT in the body: they come from the stored request,
 * so a holder cannot be tricked into signing over a nonce of someone else's
 * choosing, and the server can check the KB-JWT against what the verifier
 * actually asked for.
 */
export const ApproveRequestSchema = z.object({
  credentialId: z.uuid(),
  revealClaims: z.array(DisclosableClaimSchema).max(32).default([]),
  kbJwt: CompactJws,
})
export type ApproveRequestDto = z.infer<typeof ApproveRequestSchema>

/** Body for `POST /passport/requests/:requestId/decline`. */
export const DeclineRequestSchema = z.object({
  /** Optional, and never shown to the verifier — it is feedback for us. */
  reason: z.string().trim().max(200).optional(),
})
export type DeclineRequestDto = z.infer<typeof DeclineRequestSchema>

/**
 * Body for `POST /passport/challenge` — the wallet asking for the exact bytes to sign.
 *
 * Returns the `sd_hash`: the digest committing to the credential PLUS the chosen
 * disclosures, in the precise order they will be sent. The wallet signs that, so the key
 * binding proof cannot be reused over a substituted disclosure set.
 *
 * The private key never leaves the device; only the framing comes from here. Reproducing
 * that framing client-side would mean reproducing our claim ordering, separator handling
 * and ASCII encoding — three ways to produce a proof that fails at the counter for a reason
 * the user cannot act on.
 *
 * `nonce` and `audience` are the VERIFIER's, supplied by the caller. This endpoint does not
 * invent them: a nonce is only a replay defence if the party checking it chose it, so a
 * server-invented one would be theatre.
 */
export const ChallengeSchema = z.object({
  credentialId: z.uuid(),
  audience: z.string().trim().min(1).max(200),
  nonce: z.string().trim().min(8).max(256),
  /** Claims the holder has ticked. May be empty — that is a valid presentation. */
  revealClaims: z.array(DisclosableClaimSchema).max(32).default([]),
})
export type ChallengeDto = z.infer<typeof ChallengeSchema>

/** Body for `DELETE /passport/:id` — a holder revoking their own passport. */
export const RevokeCredentialSchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
})
export type RevokeCredentialDto = z.infer<typeof RevokeCredentialSchema>
