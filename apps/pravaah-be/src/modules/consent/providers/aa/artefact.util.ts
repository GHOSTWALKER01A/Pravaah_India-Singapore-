import { createVerify } from 'crypto'

/**
 * Verify the AA's signed consent artefact (a detached JWS) before we trust or
 * fetch against it. An unverified artefact must NOT auto-fetch (see
 * `ConsentService.applyStatus` / `ConsentNotificationService`).
 *
 * Behaviour:
 *  - Sandbox / no configured key → treated as verified (the mock issues a
 *    fixed `mock.jws.artefact`; there is no real signature to check).
 *  - Live, with AA_PUBLIC_KEY set → verify the detached JWS. The exact JWS
 *    shape (compact vs. detached, header alg) is Setu/AA-specific — CONFIRM
 *    against the AA reference and adjust here only.
 */
export function verifyArtefactSignature(
  signedArtefact: string | undefined | null,
  publicKeyPem: string | undefined,
): boolean {
  if (!signedArtefact) return false

  // Sandbox mock artefact — nothing real to verify.
  if (signedArtefact.startsWith('mock.')) return true

  // No key configured (e.g. sandbox mode) — cannot verify a real signature, so
  // do not block the flow, but this must never run in live mode without a key.
  if (!publicKeyPem) return true

  try {
    // Compact JWS: header.payload.signature (base64url). Verify the signature
    // over `header.payload` with RS256 (CONFIRM alg with the AA).
    const parts = signedArtefact.split('.')
    if (parts.length !== 3) return false
    const [header, payload, signature] = parts
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    verifier.end()
    return verifier.verify(
      normalizePem(publicKeyPem),
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}

/** Allow the key to be supplied as a single-line env var with `\n` escapes. */
function normalizePem(key: string): string {
  return key.includes('-----BEGIN')
    ? key.replace(/\\n/g, '\n')
    : `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`
}
