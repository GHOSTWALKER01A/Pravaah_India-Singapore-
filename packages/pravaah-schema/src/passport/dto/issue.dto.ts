import { z } from 'zod'

/**
 * A P-256 public JWK, as produced by the holder's device keystore.
 *
 * Validated field by field rather than accepted as an opaque object, because this
 * key becomes the `cnf` claim — the thing that decides who is allowed to present
 * the credential. A malformed or wrong-curve key here is a credential nobody can
 * ever present, and an issuer that signs one has issued a brick.
 *
 * `x` and `y` are the 32-byte affine coordinates, base64url with no padding, so
 * 43 characters exactly. A private key component (`d`) is REJECTED rather than
 * stripped: if a wallet ever sends one, that is a bug we want to fail loudly on,
 * not quietly tolerate.
 */
const B64U_32 = /^[A-Za-z0-9_-]{43}$/

export const HolderPublicJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(B64U_32, 'x must be a 32-byte base64url coordinate'),
    y: z.string().regex(B64U_32, 'y must be a 32-byte base64url coordinate'),
    // Optional, advisory, and normalised by the issuer anyway.
    kid: z.string().trim().max(200).optional(),
    alg: z.literal('ES256').optional(),
    use: z.literal('sig').optional(),
  })
  // Strict: an unexpected member is rejected rather than stripped. A wallet that sends `d`
  // has leaked a private key, and that must fail loudly instead of being quietly cleaned up.
  .strict()
export type HolderPublicJwkDto = z.infer<typeof HolderPublicJwkSchema>

/**
 * Body for `POST /passport/issue`.
 *
 * The holder generates the keypair on device, keeps the private half in the
 * Keychain/Keystore, and sends only the public half. Pravaah never sees, stores,
 * or is able to reconstruct the holder's signing key — which is precisely why a
 * stolen credential (or a stolen copy of our database) cannot be presented.
 */
export const IssueCredentialSchema = z.object({
  holderPublicJwk: HolderPublicJwkSchema,
  /**
   * A human label for the device this key lives on ("Pixel 7a"), shown in the
   * wallet so a user with two devices can tell which passport is which and
   * revoke the right one.
   */
  deviceLabel: z.string().trim().min(1).max(60).optional(),
  /**
   * Opt in to the international tier: include the (masked) passport number so a
   * foreign verifier can tie the reputation to the document they already trust.
   * Defaults to false — a domestic user should not carry a cross-border binding
   * they never asked for, and it is a HIGH-sensitivity claim.
   *
   * Ignored (with a reason returned) when M0 verified no passport.
   */
  bindPassportNumber: z.boolean().default(false),
})
export type IssueCredentialDto = z.infer<typeof IssueCredentialSchema>
