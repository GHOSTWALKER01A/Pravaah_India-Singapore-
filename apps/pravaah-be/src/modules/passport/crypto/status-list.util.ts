import { gunzipSync, gzipSync } from 'node:zlib'

import { b64uEncode } from '@/modules/passport/crypto/jose.util'

/**
 * W3C Bitstring Status List — revocation that a verifier can check offline and
 * that leaks nothing about which credential was checked.
 *
 * One bit per credential, gzipped and base64url-encoded, published as a whole. A
 * verifier fetches the entire list to check ONE credential, so we learn nothing
 * about who is being verified. That "herd privacy" is the reason the list is
 * fixed at a size far larger than our user base rather than growing with it: a
 * list holding four entries tells an observer roughly who the fourth one is.
 */

/**
 * Minimum entries in a published list, per the spec's herd-privacy guidance.
 * 131,072 bits is 16 KiB raw and compresses to a few hundred bytes while nearly
 * empty — cheap to serve, and large enough that membership reveals nothing.
 */
export const STATUS_LIST_SIZE = 131_072

export const STATUS_PURPOSE = {
  REVOCATION: 'revocation',
} as const

/** A fresh, all-zero (nothing revoked) encoded list. */
export function createEmptyList(size: number = STATUS_LIST_SIZE): string {
  return encodeList(Buffer.alloc(Math.ceil(size / 8)))
}

export function encodeList(bits: Buffer): string {
  // Level 9: the list is written rarely and read constantly, and a nearly-empty
  // bitstring compresses to a few hundred bytes — worth the CPU at write time.
  return b64uEncode(gzipSync(bits, { level: 9 }))
}

/**
 * Decode a published list back to its raw bitstring.
 *
 * Accepts base64url AND standard base64: the spec settled on base64url, but real
 * implementations in the wild emit both, and a verifier that rejects a valid list
 * on an encoding technicality fails closed against a credential that is fine.
 */
export function decodeList(encoded: string): Buffer {
  return gunzipSync(Buffer.from(encoded, 'base64url'))
}

/**
 * Bit order.
 *
 * The spec indexes bit `i` as the (i mod 8)-th MOST significant bit of byte
 * (i div 8) — big-endian within each byte. This is the single most common
 * interoperability bug in status-list implementations, because the intuitive
 * `1 << (i & 7)` (little-endian) also "works" as long as the same code both sets
 * and reads the bit. It only fails against somebody else's verifier, which is
 * exactly the audience a cross-border credential is built for.
 */
function bitMask(index: number): number {
  return 0x80 >> (index & 7)
}

export function getBit(bits: Buffer, index: number): boolean {
  const byte = index >> 3
  if (byte < 0 || byte >= bits.length) {
    // Out of range means the list does not cover this credential. Nothing here
    // can prove it is live, so the caller must treat it as revoked.
    return true
  }
  return (bits[byte]! & bitMask(index)) !== 0
}

export function setBit(bits: Buffer, index: number, value: boolean): Buffer {
  const byte = index >> 3
  if (byte < 0 || byte >= bits.length) {
    throw new RangeError(`Status list index ${index} is outside the list`)
  }
  // Copy rather than mutate: the caller's buffer is usually the decoded form of
  // the currently-published list, and an in-place flip would silently change what
  // a concurrent reader is serving.
  const next = Buffer.from(bits)
  if (value) next[byte]! |= bitMask(index)
  else next[byte]! &= ~bitMask(index) & 0xff
  return next
}

/** Read one credential's bit straight from the published encoding. */
export function isRevokedInList(encoded: string, index: number): boolean {
  try {
    return getBit(decodeList(encoded), index)
  } catch {
    // A list we cannot decode proves nothing. Fail CLOSED: an unreadable
    // revocation list must never be read as "not revoked", because that is
    // precisely the state an attacker would engineer.
    return true
  }
}

/** Flip one credential's bit and return the new published encoding. */
export function withBit(
  encoded: string,
  index: number,
  value: boolean,
): string {
  return encodeList(setBit(decodeList(encoded), index, value))
}

/**
 * The `credentialSubject` of a status-list credential, as a verifier expects to
 * find it after validating our signature over it.
 */
export interface StatusListSubject {
  id: string
  type: 'BitstringStatusList'
  statusPurpose: string
  encodedList: string
}

export function statusListSubject(args: {
  uri: string
  purpose: string
  encodedList: string
}): StatusListSubject {
  return {
    id: `${args.uri}#list`,
    type: 'BitstringStatusList',
    statusPurpose: args.purpose,
    encodedList: args.encodedList,
  }
}
