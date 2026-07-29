/**
 * GF(256) and Reed-Solomon — the arithmetic the whole error-correction scheme lives in.
 *
 * Split out from the encoder because this layer is pure mathematics with no knowledge of QR
 * matrices, and it is the layer `scripts/verify-qr.ts` checks hardest: two of the three real bugs
 * found while writing this encoder were in `rsGenerator` alone. Isolating it means the harness can
 * cross-check it against a naive long division without touching matrix code.
 */

/**
 * The Galois field.
 *
 * Built once at module load from the primitive polynomial 0x11D, which is the one QR specifies.
 * `EXP` and `LOG` turn field multiplication into an addition of logarithms — the standard trick, and
 * the reason Reed-Solomon is cheap enough to run on a phone while a user watches.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    // 0x11D — x^8 + x^4 + x^3 + x^2 + 1, the field QR is defined over.
    if (x & 0x100) x ^= 0x11d;
  }
  // Mirrored so a multiply can add exponents without a modulo.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
export function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      // Coefficients run highest-degree first, so multiplying by (x + a) contributes p_j to the
      // SAME index for the x term and a·p_j to the next one for the constant term. Swapping these
      // two lines builds a different polynomial that still looks plausible and corrects nothing.
      next[j] = (next[j]! ^ poly[j]!) as number;
      next[j + 1] = (next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!)) as number;
    }
    poly = next;
  }
  return poly;
}

/** The Reed-Solomon remainder: polynomial long division in GF(256). */
export function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  const generator = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      remainder[i] = (remainder[i]! ^
        gfMul(generator[i + 1]!, factor)) as number;
    }
  }
  return remainder;
}

/** The field tables, for the verification harness only. */
export const __gfTables = { EXP, LOG };
