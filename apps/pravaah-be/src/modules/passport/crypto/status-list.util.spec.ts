import { gunzipSync } from 'node:zlib'

import {
  STATUS_LIST_SIZE,
  createEmptyList,
  decodeList,
  encodeList,
  getBit,
  isRevokedInList,
  setBit,
  statusListSubject,
  withBit,
} from '@/modules/passport/crypto/status-list.util'

describe('status-list.util', () => {
  it('creates an all-clear list of the herd-privacy size', () => {
    const encoded = createEmptyList()
    const bits = decodeList(encoded)

    expect(bits.length).toBe(STATUS_LIST_SIZE / 8)
    expect(bits.every((byte) => byte === 0)).toBe(true)
    // 16 KiB of zeros compresses to a few hundred bytes, which is what makes
    // publishing the WHOLE list on every check affordable.
    expect(encoded.length).toBeLessThan(500)
  })

  it('is big enough that membership reveals nothing', () => {
    // A list holding four entries tells an observer roughly who the fourth one is.
    // The spec's guidance is a minimum of 131,072 entries, and it is a privacy
    // property rather than a capacity choice — hence the assertion.
    expect(STATUS_LIST_SIZE).toBeGreaterThanOrEqual(131_072)
  })

  it('indexes bits big-endian within each byte, as the spec requires', () => {
    // THE interop bug in status-list implementations. The intuitive `1 << (i & 7)`
    // (little-endian) is self-consistent — it sets and reads the same bit — so it
    // passes every test written against itself, and fails only against SOMEBODY
    // ELSE's verifier. Which is the entire audience for a cross-border credential.
    const bits = setBit(Buffer.alloc(2), 0, true)
    expect(bits[0]).toBe(0x80)

    expect(setBit(Buffer.alloc(2), 7, true)[0]).toBe(0x01)
    expect(setBit(Buffer.alloc(2), 8, true)[1]).toBe(0x80)
    expect(setBit(Buffer.alloc(2), 15, true)[1]).toBe(0x01)
  })

  it('sets and clears an individual bit without disturbing its neighbours', () => {
    // Annotated, because `Buffer.alloc` narrows to `Buffer<ArrayBuffer>` while `setBit`
    // returns the wider `Buffer<ArrayBufferLike>`.
    let bits: Buffer = Buffer.alloc(4)
    bits = setBit(bits, 3, true)
    bits = setBit(bits, 4, true)

    expect(getBit(bits, 3)).toBe(true)
    expect(getBit(bits, 4)).toBe(true)
    expect(getBit(bits, 2)).toBe(false)
    expect(getBit(bits, 5)).toBe(false)

    bits = setBit(bits, 3, false)
    expect(getBit(bits, 3)).toBe(false)
    expect(getBit(bits, 4)).toBe(true)
  })

  it('does not mutate the caller’s buffer', () => {
    // The caller's buffer is usually the decoded form of the list currently being
    // SERVED, so an in-place flip would change what a concurrent reader publishes.
    const original = Buffer.alloc(2)
    const updated = setBit(original, 5, true)

    expect(original[0]).toBe(0)
    expect(updated[0]).not.toBe(0)
  })

  it('round-trips one credential’s revocation through the published encoding', () => {
    const empty = createEmptyList()
    expect(isRevokedInList(empty, 9_001)).toBe(false)

    const revoked = withBit(empty, 9_001, true)
    expect(isRevokedInList(revoked, 9_001)).toBe(true)
    // Every other credential is untouched — a revocation is one bit, not a reissue.
    expect(isRevokedInList(revoked, 9_000)).toBe(false)
    expect(isRevokedInList(revoked, 9_002)).toBe(false)

    expect(isRevokedInList(withBit(revoked, 9_001, false), 9_001)).toBe(false)
  })

  it('treats an out-of-range index as revoked', () => {
    // The list does not cover this credential, so nothing here can prove it is live.
    // Reading a gap as "not revoked" is exactly the state an attacker would engineer.
    const bits = Buffer.alloc(2)
    expect(getBit(bits, 999)).toBe(true)
    expect(getBit(bits, -1)).toBe(true)
  })

  it('fails CLOSED on a list it cannot decode', () => {
    // An unreadable revocation list must never read as "not revoked".
    expect(isRevokedInList('not-gzip-at-all', 1)).toBe(true)
    expect(isRevokedInList('', 1)).toBe(true)
  })

  it('refuses to set a bit outside the list rather than silently growing it', () => {
    expect(() => setBit(Buffer.alloc(2), 500, true)).toThrow(RangeError)
  })

  it('accepts standard base64 as well as base64url', () => {
    // The spec settled on base64url, but real implementations emit both. A verifier
    // that fails closed on an encoding technicality rejects a credential that is fine.
    const encoded = encodeList(setBit(Buffer.alloc(64), 5, true))
    const asStandardBase64 = Buffer.from(encoded, 'base64url').toString('base64')

    expect(isRevokedInList(asStandardBase64, 5)).toBe(true)
  })

  it('produces a gzip payload a standard reader can inflate', () => {
    const bits = setBit(Buffer.alloc(32), 3, true)
    const inflated = gunzipSync(Buffer.from(encodeList(bits), 'base64url'))
    expect(inflated).toEqual(bits)
  })

  it('shapes the credentialSubject the way a verifier expects to find it', () => {
    const subject = statusListSubject({
      uri: 'https://pravaah.app/api/v1/status/1',
      purpose: 'revocation',
      encodedList: 'H4sI',
    })

    expect(subject).toEqual({
      id: 'https://pravaah.app/api/v1/status/1#list',
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      encodedList: 'H4sI',
    })
  })
})
