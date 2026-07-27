import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'crypto'

/**
 * ReBIT FI-data crypto (X25519 ECDH → HKDF → AES-256-GCM), implemented with
 * Node's built-in `crypto` (no third-party curve libs).
 *
 * PRAGMATIC PATH: prefer the provider's decrypted-fetch (Setu `format: json`,
 * or the sandbox mock) so FI data arrives already decrypted. This util is the
 * documented FALLBACK for self-decrypt / Finvu, and demonstrates that we
 * understand the ReBIT scheme.
 *
 * ⚠ The exact IV/salt derivation must match your AA's ReBIT implementation —
 * CONFIRM against the AA's decrypt reference before relying on self-decrypt.
 */

const b64ToUrl = (b64: string): string =>
  b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function publicKeyFromRaw(rawB64: string) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64ToUrl(rawB64) },
    format: 'jwk',
  })
}

function privateKeyFromRaw(privB64: string, pubB64: string) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      d: b64ToUrl(privB64),
      x: b64ToUrl(pubB64),
    },
    format: 'jwk',
  })
}

export interface KeyMaterial {
  privateKey: string // base64 raw d
  publicKey: string // base64 raw x
  nonce: string // base64 32-byte nonce
}

/** Generate ephemeral X25519 key material to send in the FI request. */
export function generateKeyMaterial(): KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string }
  const urlToB64 = (u: string): string =>
    Buffer.from(u, 'base64url').toString('base64')
  return {
    publicKey: urlToB64(pubJwk.x),
    privateKey: urlToB64(privJwk.d),
    nonce: randomBytes(32).toString('base64'),
  }
}

/** Decrypt one FIP payload per the ReBIT ECDH scheme. */
export function decryptFi(params: {
  ourPrivateKeyB64: string
  ourPublicKeyB64: string
  ourNonceB64: string
  remotePublicKeyB64: string
  remoteNonceB64: string
  cipherB64: string
}): string {
  const shared = diffieHellman({
    privateKey: privateKeyFromRaw(
      params.ourPrivateKeyB64,
      params.ourPublicKeyB64,
    ),
    publicKey: publicKeyFromRaw(params.remotePublicKeyB64),
  })

  // ReBIT: session key via HKDF over the shared secret; IV/salt from the XOR of
  // the two 32-byte nonces (first 20 bytes = salt, last 12 = AES-GCM IV).
  const ourNonce = Buffer.from(params.ourNonceB64, 'base64')
  const remoteNonce = Buffer.from(params.remoteNonceB64, 'base64')
  const xorNonce = Buffer.from(ourNonce.map((b, i) => b ^ remoteNonce[i]))
  const salt = xorNonce.subarray(0, 20)
  const iv = xorNonce.subarray(20, 32)

  const key = Buffer.from(
    hkdfSync('sha256', shared, salt, Buffer.alloc(0), 32),
  )

  // The last 16 bytes of the ciphertext are the GCM auth tag.
  const cipher = Buffer.from(params.cipherB64, 'base64')
  const tag = cipher.subarray(cipher.length - 16)
  const body = cipher.subarray(0, cipher.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    'utf8',
  )
}
