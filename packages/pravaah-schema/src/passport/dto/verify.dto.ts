import { z } from 'zod'

import {
  DisclosableClaimSchema,
  PresentationTemplateIdSchema,
} from '../schemas/claims.schema'
import { PresentationChannelSchema } from '../schemas/passport-enums.schema'

/**
 * Body for `POST /verify` — a partner handing us a presentation to check.
 *
 * Two accepted shapes, because a verifier may be holding either:
 *
 *  - `presentation`: the single combined SD-JWT VC string,
 *    `<sd-jwt>~<disclosure>~…~<kb-jwt>`. This is the wire format the IETF spec
 *    defines and what a wallet, a QR, or an NFC tap actually hands over.
 *  - `sdJwt` + `disclosures` + `kbJwt`: the same data pre-split, for callers who
 *    parsed it themselves.
 *
 * Exactly one shape must be present. Accepting both and silently preferring one
 * would let a caller send a mismatched pair and get a verdict about the half we
 * happened to read.
 */
export const VerifyPresentationSchema = z
  .object({
    presentation: z.string().trim().min(20).max(65536).optional(),

    sdJwt: z.string().trim().min(20).max(65536).optional(),
    disclosures: z.array(z.string().trim().min(4).max(8192)).max(64).optional(),
    kbJwt: z.string().trim().min(20).max(4096).optional(),

    /**
     * The nonce this verifier issued. Optional only so an offline/relay verifier
     * can still check the issuer signature — but omitting it means the result
     * comes back with `replayProtected: false`, and a verifier that ignores that
     * flag has no defence against a replayed presentation.
     */
    expectedNonce: z.string().trim().min(8).max(256).optional(),
    /** The verifier's own identifier. Must equal the KB-JWT `aud`. */
    audience: z.string().trim().min(1).max(200).optional(),
    /**
     * Claims the verifier required. Any that are missing come back in
     * `unsatisfied` — the verifier learns the holder declined, instead of
     * reading `undefined` as "false".
     */
    requiredClaims: z.array(DisclosableClaimSchema).max(32).optional(),
    channel: PresentationChannelSchema.default('API'),
  })
  .refine((v) => !!v.presentation !== !!v.sdJwt, {
    message:
      'Send either `presentation` (combined format) or `sdJwt` + `disclosures`, not both',
    path: ['presentation'],
  })
  .refine((v) => !v.sdJwt || Array.isArray(v.disclosures), {
    message: '`disclosures` is required when sending a split `sdJwt`',
    path: ['disclosures'],
  })
export type VerifyPresentationDto = z.infer<typeof VerifyPresentationSchema>

/**
 * Body for `POST /verify/request` — a verifier opening a request the holder will
 * approve in their wallet. This is the device-engagement handshake behind a card
 * tap: the card carries only a reference, so possession of the card is never
 * enough to learn anything.
 *
 * Either name a template or list claims explicitly. A template is preferred — it
 * carries a purpose sentence the wallet can show, and "this landlord asked for the
 * cross-border tenancy set" is a far better consent prompt than six raw keys.
 */
export const CreateVerifierRequestSchema = z
  .object({
    template: PresentationTemplateIdSchema.optional(),
    requestedClaims: z.array(DisclosableClaimSchema).min(1).max(32).optional(),
    /** Shown verbatim to the holder. Required when not using a template. */
    purpose: z.string().trim().min(5).max(300).optional(),
    /**
     * Card reference from a scanned QR / NFC tap. When present the request is
     * bound to that card's credential, so the holder sees "this card, tapped at
     * this merchant" rather than an unattributed prompt.
     */
    cardRef: z.string().trim().min(8).max(64).optional(),
    /**
     * The Pravaah ID of the holder being asked, when the verifier has it (typed
     * in at a counter). Lets us route the request without a card.
     */
    pravaahId: z.string().trim().max(24).optional(),
    channel: PresentationChannelSchema.default('QR'),
    /** How long the holder has to respond, in seconds. */
    ttlSeconds: z.number().int().min(30).max(900).default(300),
  })
  .refine((v) => !!v.template || !!v.requestedClaims, {
    message: 'Provide either a `template` or an explicit `requestedClaims` list',
    path: ['template'],
  })
  .refine((v) => !!v.template || !!v.purpose, {
    message:
      'An explicit claim list needs a `purpose` — the holder must be told why',
    path: ['purpose'],
  })
  .refine((v) => !!v.cardRef || !!v.pravaahId, {
    message:
      'Identify the holder with a `cardRef` (scanned card) or a `pravaahId`',
    path: ['cardRef'],
  })
export type CreateVerifierRequestDto = z.infer<
  typeof CreateVerifierRequestSchema
>
