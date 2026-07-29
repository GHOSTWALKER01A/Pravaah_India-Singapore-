import { BitBuffer, buildCodewords, pickSpec, utf8Bytes } from './bitstream';
import {
  applyFormat,
  applyVersion,
  blank,
  MASKS,
  penalty,
  placeAlignment,
  placeData,
  placeFinder,
  placeTiming,
  reserve,
  type Grid,
} from './matrix';
import { gfMul, rsGenerator, rsRemainder, __gfTables } from './galois';

export { QrTooLongError } from './version-tables';

/**
 * A QR encoder. Model 2, byte mode, error-correction level M, versions 1–10.
 *
 * Written rather than installed, for two reasons that both matter here:
 *
 * 1. **The monorepo's install is fragile and pinned.** `PRODUCT.md` records that adding a dependency
 *    is a real risk — root `overrides` hold `react-native@0.81.5` and `disableHierarchicalLookup`
 *    keeps a single `react@19.1.0`. A QR library is not worth disturbing that for.
 * 2. **DESIGN.md already requires it.** Guilloche and microtext are "real generated geometry, never
 *    a raster texture". A QR is exactly that: a deterministic function of a string. Pulling in a
 *    library to draw it would be the one place the surface stopped generating its own marks.
 *
 * Level M (≈15% recovery) is the right choice for a UPI intent: a `upi://pay?...` string runs 60–200
 * bytes, and M keeps that inside version 6–8 while surviving a creased or partly-shadowed print.
 * Level L would fit a smaller matrix, but a payment code that fails to scan on a scuffed sticker is
 * a payment that does not happen.
 *
 * Correctness is not assumed: `scripts/verify-qr.ts` checks the Galois field, the Reed-Solomon
 * remainder against an independent naive long division, the structural invariants of the matrix, and
 * that known payloads land on the version the specification says they should.
 *
 * The four modules behind this barrel are the encoder's real seams: `galois` is pure field
 * arithmetic, `version-tables` is transcribed specification data, `bitstream` turns a string into
 * interleaved codewords, and `matrix` places them. Two of the three bugs found while writing this
 * lived in `galois` and `matrix` respectively, which is why they are separately testable.
 */

export interface QrCode {
  size: number;
  /** Row-major, `true` for a dark module. */
  modules: boolean[][];
  version: number;
  mask: number;
}

/**
 * Encode a payload into a QR matrix.
 *
 * Deterministic: the same string always produces the same matrix, which matters because a shopfront
 * code must engrave identically on every launch. No randomness anywhere.
 */
export function encodeQr(payload: string): QrCode {
  const bytes = utf8Bytes(payload);
  const spec = pickSpec(bytes.length);

  const buffer = new BitBuffer();
  // Byte mode.
  buffer.push(0b0100, 4);
  buffer.push(bytes.length, spec.version < 10 ? 8 : 16);
  for (const byte of bytes) buffer.push(byte, 8);

  const codewords = buildCodewords(
    spec,
    buffer.toCodewords(spec.dataCodewords),
  );

  const size = spec.version * 4 + 17;
  const base = blank(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, spec.version);
  placeTiming(base);
  reserve(base, spec.version);

  // Everything already set is function-pattern territory and data must step around it.
  const reserved = base.map((row) => Array.from(row, (cell) => cell !== -1));

  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row) => Int8Array.from(row));
    placeData(grid, codewords, reserved);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r]![c]) continue;
        if (MASKS[mask]!(r, c)) grid[r]![c] = (grid[r]![c]! ^ 1) as number;
      }
    }
    applyFormat(grid, mask);
    applyVersion(grid, spec.version);

    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, mask, score };
  }

  const chosen = best!;
  return {
    size,
    modules: chosen.grid.map((row) => Array.from(row, (cell) => cell === 1)),
    version: spec.version,
    mask: chosen.mask,
  };
}

/** Exposed for the verification script. Not part of the component API. */
export const __internals = {
  EXP: __gfTables.EXP,
  LOG: __gfTables.LOG,
  gfMul,
  rsRemainder,
  rsGenerator,
  pickSpec,
  utf8Bytes,
};
