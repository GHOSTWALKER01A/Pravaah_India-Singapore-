/**
 * The specification's tables for level M, byte mode, versions 1–10.
 *
 * Pure data, kept apart from the code that reads it so a transcription error is reviewable as a
 * table rather than buried in an algorithm. Every number here comes from ISO/IEC 18004; none of it
 * is derived at runtime, because a "clever" derivation of the block split is exactly how you get a
 * matrix that looks plausible and decodes to nothing.
 */

/**
 * Per version: total data codewords, EC codewords per block, and the block split.
 *
 * `[g1, c1, g2, c2]` is `g1` blocks of `c1` data codewords followed by `g2` blocks of `c2`. The
 * asymmetry from version 8 upwards is real — version 8 is 2×38 + 2×39, not 4×38.
 */
export interface VersionSpec {
  version: number;
  /** Data codewords available for the payload. */
  dataCodewords: number;
  /** EC codewords per block. */
  ecPerBlock: number;
  blocks: [number, number, number, number];
}

export const SPECS: VersionSpec[] = [
  { version: 1, dataCodewords: 16, ecPerBlock: 10, blocks: [1, 16, 0, 0] },
  { version: 2, dataCodewords: 28, ecPerBlock: 16, blocks: [1, 28, 0, 0] },
  { version: 3, dataCodewords: 44, ecPerBlock: 26, blocks: [1, 44, 0, 0] },
  { version: 4, dataCodewords: 64, ecPerBlock: 18, blocks: [2, 32, 0, 0] },
  { version: 5, dataCodewords: 86, ecPerBlock: 24, blocks: [2, 43, 0, 0] },
  { version: 6, dataCodewords: 108, ecPerBlock: 16, blocks: [4, 27, 0, 0] },
  { version: 7, dataCodewords: 124, ecPerBlock: 18, blocks: [4, 31, 0, 0] },
  { version: 8, dataCodewords: 154, ecPerBlock: 22, blocks: [2, 38, 2, 39] },
  { version: 9, dataCodewords: 182, ecPerBlock: 22, blocks: [3, 36, 2, 37] },
  { version: 10, dataCodewords: 216, ecPerBlock: 26, blocks: [4, 43, 1, 44] },
];

/** Alignment-pattern centre coordinates, per version. Version 1 has none. */
export const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** Format-information bit strings for level M, one per mask. Pre-computed from the spec. */
export const FORMAT_BITS_M = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

/** Version-information bit strings, versions 7–10. Below 7 the matrix carries none. */
export const VERSION_BITS: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

export class QrTooLongError extends Error {
  constructor(bytes: number) {
    super(
      `That payload is ${bytes} bytes, which does not fit a version-10 QR at level M (216 max).`,
    );
  }
}
