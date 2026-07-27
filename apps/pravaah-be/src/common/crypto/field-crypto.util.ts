import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

/**
 * AES-256-GCM field-level encryption for raw provider payloads. Raw KYC
 * responses (which may contain PII) are NEVER persisted in the clear — only
 * their encrypted blob (for dispute/audit) plus a masked projection for admins.
 *
 * Envelope format: `v1:iv:tag:ciphertext` (each part base64). The `v1` prefix
 * is a key-version marker so a future rotation can decrypt old blobs by id.
 */
const ALGO = 'aes-256-gcm'
const KEY_VERSION = 'v1'

let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.FIELD_ENCRYPTION_KEY
  if (!raw) {
    throw new Error('FIELD_ENCRYPTION_KEY is not defined in environment')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }
  cachedKey = key
  return key
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${KEY_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptField(payload: string): string {
  const [, ivB64, tagB64, dataB64] = payload.split(':')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted field payload')
  }
  const decipher = createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivB64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

// ── Masking helpers — the only projection of sensitive identifiers admins see ──
export const maskAadhaar = (n: string): string =>
  `XXXX XXXX ${n.slice(-4)}`
export const maskPan = (p: string): string =>
  `${p.slice(0, 2)}XXXXX${p.slice(-1)}`
export const maskAccount = (a: string): string => `XXXX${a.slice(-4)}`
