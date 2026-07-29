import { ALIGNMENT, FORMAT_BITS_M, VERSION_BITS } from './version-tables';

/**
 * The matrix: function patterns, data placement, masking, and the two information areas.
 *
 * `-1` means unset, and it is load-bearing rather than a convenience. Data placement must step
 * around every module a function pattern already owns, and the only reliable way to know which
 * those are is to build the patterns first and then snapshot what is still `-1`. A grid initialised
 * to `0` would make "light module" and "nothing here yet" the same value, and the data would
 * overwrite the timing pattern.
 */

/** -1 unset, 0 light, 1 dark. */
export type Grid = Int8Array[];

export function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

export function placeFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= grid.length || cc >= grid.length) continue;
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const ring =
        r === 0 ||
        r === 6 ||
        c === 0 ||
        c === 6 ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      grid[rr]![cc] = inner && ring ? 1 : 0;
    }
  }
}

export function placeAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT[version] ?? [];
  const size = grid.length;
  for (const r of centres) {
    for (const c of centres) {
      // The three finder corners already own their space.
      const nearFinder =
        (r <= 8 && c <= 8) ||
        (r <= 8 && c >= size - 9) ||
        (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          grid[r + dr]![c + dc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }
}

export function placeTiming(grid: Grid): void {
  const size = grid.length;
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (grid[6]![i] === -1) grid[6]![i] = bit;
    if (grid[i]![6] === -1) grid[i]![6] = bit;
  }
}

/** Reserve the format and version areas so data placement skips them. */
export function reserve(grid: Grid, version: number): void {
  const size = grid.length;
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === -1) grid[8]![i] = 0;
    if (grid[i]![8] === -1) grid[i]![8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8]![size - 1 - i] === -1) grid[8]![size - 1 - i] = 0;
    if (grid[size - 1 - i]![8] === -1) grid[size - 1 - i]![8] = 0;
  }
  // The dark module. Always set, always here.
  grid[size - 8]![8] = 1;

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      if (grid[a]![b] === -1) grid[a]![b] = 0;
      if (grid[b]![a] === -1) grid[b]![a] = 0;
    }
  }
}

/** Walk the zigzag and drop the bit stream in. */
export function placeData(
  grid: Grid,
  codewords: Uint8Array,
  reserved: boolean[][],
): void {
  const size = grid.length;
  let bit = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    const colPair = right === 6 ? [5, 4] : [right, right - 1];
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of colPair) {
        if (reserved[row]![col]) continue;
        const byte = codewords[bit >> 3] ?? 0;
        grid[row]![col] = ((byte >>> (7 - (bit & 7))) & 1) as number;
        bit++;
      }
    }
    upward = !upward;
    if (right === 6) right -= 1;
  }
}

export const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * The specification's penalty score. Lower is better.
 *
 * Implemented rather than hard-coding mask 0, because the mask exists to break up runs and large
 * blocks that confuse a scanner — and a UPI payload is highly repetitive (`%40`, `&`, `=`), which is
 * exactly the input that produces a bad matrix under a fixed mask.
 */
export function penalty(grid: Grid): number {
  const size = grid.length;
  let score = 0;

  // Rule 1: runs of five or more.
  for (let i = 0; i < size; i++) {
    for (const line of [
      Array.from({ length: size }, (_, j) => grid[i]![j]!),
      Array.from({ length: size }, (_, j) => grid[j]![i]!),
    ]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r]![c];
      if (
        v === grid[r]![c + 1] &&
        v === grid[r + 1]![c] &&
        v === grid[r + 1]![c + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern.
  const needle = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const row = needle.every((n, k) => grid[i]![j + k] === n);
      const col = needle.every((n, k) => grid[j + k]![i] === n);
      const rowRev = needle.every((n, k) => grid[i]![j + 10 - k] === n);
      const colRev = needle.every((n, k) => grid[j + 10 - k]![i] === n);
      if (row) score += 40;
      if (col) score += 40;
      if (rowRev) score += 40;
      if (colRev) score += 40;
    }
  }

  // Rule 4: deviation from a 50/50 balance of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) if (grid[r]![c] === 1) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

export function applyFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = FORMAT_BITS_M[mask]!;
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >>> i) & 1) as number;
    // Copy 1, around the top-left finder.
    if (i < 6) grid[8]![i] = bit;
    else if (i === 6) grid[8]![7] = bit;
    else if (i === 7) grid[8]![8] = bit;
    else if (i === 8) grid[7]![8] = bit;
    else grid[14 - i]![8] = bit;

    /**
     * Copy 2, split between the other two corners.
     *
     * The first eight bits run along ROW 8 towards the right edge; the last seven run down COLUMN 8
     * from the bottom edge. Transposing these two — which is the easy mistake, and one this encoder
     * actually made — also overwrites the dark module at (size-8, 8), and the resulting code scans
     * as nothing.
     */
    if (i < 8) grid[8]![size - 1 - i] = bit;
    else grid[size - 15 + i]![8] = bit;
  }
}

export function applyVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = VERSION_BITS[version]!;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) as number;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    grid[a]![b] = bit;
    grid[b]![a] = bit;
  }
}
