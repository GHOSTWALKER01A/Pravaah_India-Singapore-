import { rsRemainder } from './galois';
import { QrTooLongError, SPECS, type VersionSpec } from './version-tables';

/**
 * Turning a string into the interleaved codeword stream the matrix consumes.
 *
 * Everything here is about the fact that QR's data stream is not byte-aligned until it is padded,
 * and that the codewords are not laid out in the order they were produced.
 */

/** A bit accumulator. */
export class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pad to a byte boundary, then to capacity with the specified alternating pad bytes. */
  toCodewords(dataCodewords: number): Uint8Array {
    const capacity = dataCodewords * 8;
    // Terminator: up to four zero bits, but never past capacity.
    const terminator = Math.min(4, capacity - this.bits.length);
    for (let i = 0; i < terminator; i++) this.bits.push(0);
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const out = new Uint8Array(dataCodewords);
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out[i / 8] = byte;
    }
    // 0xEC, 0x11 alternating — the specification's own pad bytes, not zeroes.
    let cursor = this.bits.length / 8;
    let alternate = true;
    while (cursor < dataCodewords) {
      out[cursor++] = alternate ? 0xec : 0x11;
      alternate = !alternate;
    }
    return out;
  }
}

export function utf8Bytes(text: string): Uint8Array {
  // A UPI payload is percent-encoded ASCII in practice, but a payee name can carry anything, so
  // this encodes properly rather than assuming one byte per character.
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(out);
}

export function pickSpec(byteLength: number): VersionSpec {
  // The character-count field is 8 bits below version 10 and 16 bits at 10, so the header cost
  // differs and the fit has to account for it.
  for (const spec of SPECS) {
    const countBits = spec.version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (needed <= spec.dataCodewords) return spec;
  }
  throw new QrTooLongError(byteLength);
}

/** Interleave data and EC codewords across blocks, as the specification requires. */
export function buildCodewords(
  spec: VersionSpec,
  data: Uint8Array,
): Uint8Array {
  const [g1, c1, g2, c2] = spec.blocks;
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];

  let cursor = 0;
  for (let i = 0; i < g1; i++) {
    const slice = data.subarray(cursor, cursor + c1);
    cursor += c1;
    blocks.push({ data: slice, ec: rsRemainder(slice, spec.ecPerBlock) });
  }
  for (let i = 0; i < g2; i++) {
    const slice = data.subarray(cursor, cursor + c2);
    cursor += c2;
    blocks.push({ data: slice, ec: rsRemainder(slice, spec.ecPerBlock) });
  }

  const out: number[] = [];
  const maxData = Math.max(c1, g2 > 0 ? c2 : 0);
  // Column-major across blocks: byte 0 of every block, then byte 1 of every block, and so on.
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]!);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of blocks) out.push(block.ec[i]!);
  }
  return new Uint8Array(out);
}
