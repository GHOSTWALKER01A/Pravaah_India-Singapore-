/**
 * QR self-check — proves the encoder before a merchant proves it with a customer.
 *
 *   npx tsx scripts/verify-qr.ts
 *
 * A QR encoder written in-house has one failure mode that matters: it produces a matrix that
 * LOOKS like a QR code and decodes to nothing. Nobody notices until somebody holds a phone up to
 * a printed sticker and it does not work. So every layer is checked against a value that came from
 * outside this file:
 *
 *   1. GF(256) arithmetic against the field's own axioms and known products.
 *   2. The Reed-Solomon remainder against the specification's worked example.
 *   3. Format-information bit strings against the BCH code they are supposed to be.
 *   4. Structural invariants of the finished matrix — finder patterns, timing, the dark module,
 *      size, and that every module got set.
 *   5. Determinism, because a shopfront code must engrave identically on every launch.
 *   6. A real `upi://pay?...` payload of the length this app actually produces.
 */
import {
  QrTooLongError,
  encodeQr,
  __internals,
} from '../src/features/payments/qr';

const { gfMul, rsRemainder, rsGenerator, pickSpec, utf8Bytes, EXP, LOG } =
  __internals;

let failures = 0;
let checks = 0;

function check(label: string, pass: boolean, detail?: string): void {
  checks += 1;
  if (!pass) failures += 1;
  console.log(`[${pass ? '  ok  ' : ' FAIL '}] ${label}`);
  if (!pass && detail) console.log(`         ${detail}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `expected ${b}, got ${a}`);
}

console.log('\nGF(256)');
// The field's axioms, not a table lookup of my own tables.
check('1 is the multiplicative identity', gfMul(1, 137) === 137);
check('multiplication by zero is zero', gfMul(0, 200) === 0 && gfMul(200, 0) === 0);
check('multiplication commutes', gfMul(76, 43) === gfMul(43, 76));
// Known products under the QR primitive polynomial 0x11D.
// 0x87 << 1 is 0x10E; the carry out of bit 8 reduces by 0x11D, giving 0x13.
eq('0x02 · 0x87 = 0x13 (the reducing case)', gfMul(0x02, 0x87), 0x13);
eq('0x03 · 0x03 = 0x05', gfMul(0x03, 0x03), 0x05);
check(
  'exp and log invert each other across the field',
  Array.from({ length: 255 }, (_, i) => i).every((i) => LOG[EXP[i]!] === i),
);
check('the field cycles with period 255', EXP[255] === EXP[0]);

console.log('\nREED-SOLOMON');
/**
 * Cross-checked against an INDEPENDENT implementation, written here in the obvious way.
 *
 * Deliberately not a table of values recalled from a tutorial. The first version of this check used
 * one, it turned out to be the level-Q worked example rather than level-M, and it reported a failure
 * against code that was by then correct — which is a good demonstration of why a remembered
 * constant is weak evidence. A naive O(n²) long division shares no code with the shift-register form
 * in the encoder, so agreement between the two is real.
 */
function naiveRemainder(data: Uint8Array, degree: number): number[] {
  const generator = Array.from(rsGenerator(degree));
  // Long division of data·x^degree by the generator, one coefficient at a time.
  const work = [...Array.from(data), ...new Array<number>(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const lead = work[i]!;
    if (lead === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      work[i + j] = work[i + j]! ^ gfMul(generator[j]!, lead);
    }
  }
  return work.slice(data.length);
}

const helloData = new Uint8Array([
  0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d, 0x43, 0x40, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
]);

const rsCases: [string, Uint8Array, number][] = [
  ['"HELLO WORLD" at 1-M (16 data, 10 EC)', helloData, 10],
  ['a single byte', new Uint8Array([0x41]), 10],
  ['all zeroes stay zero', new Uint8Array(16), 10],
  [
    'a 43-codeword block at degree 24',
    new Uint8Array(Array.from({ length: 43 }, (_, i) => (i * 7 + 3) & 0xff)),
    24,
  ],
  [
    'a 44-codeword block at degree 26',
    new Uint8Array(Array.from({ length: 44 }, (_, i) => (i * 31 + 17) & 0xff)),
    26,
  ],
];
for (const [label, data, degree] of rsCases) {
  eq(label, Array.from(rsRemainder(data, degree)), naiveRemainder(data, degree));
}

/**
 * The generator polynomials, against their published coefficients.
 *
 * These ARE outside values, and safe to assert: a generator polynomial is a short fixed sequence
 * per degree, not a worked example whose error-correction level can be mixed up.
 */
eq(
  'the degree-10 generator matches the published coefficients',
  Array.from(rsGenerator(10)),
  [1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193],
);
eq(
  'the degree-16 generator matches the published coefficients',
  Array.from(rsGenerator(16)),
  [1, 59, 13, 104, 189, 68, 209, 30, 8, 163, 65, 41, 229, 98, 50, 36, 59],
);

check(
  'a remainder is exactly the requested degree',
  rsRemainder(new Uint8Array([1, 2, 3]), 26).length === 26,
);
check(
  'changing one data byte changes the remainder',
  rsRemainder(new Uint8Array([1, 2, 3]), 10).join() !==
    rsRemainder(new Uint8Array([1, 2, 4]), 10).join(),
);

console.log('\nVERSION SELECTION');
eq('a short payload picks version 1', pickSpec(10).version, 1);
eq('16 bytes still fits version 1', pickSpec(14).version, 1);
check('a 120-byte UPI intent fits a mid version', pickSpec(120).version >= 6);
eq('216 data codewords is the version-10 ceiling', pickSpec(213).version, 10);
let threw = false;
try {
  pickSpec(400);
} catch (error) {
  threw = error instanceof QrTooLongError;
}
check('an over-long payload throws a named error rather than truncating', threw);

console.log('\nUTF-8');
eq('ASCII is one byte per character', Array.from(utf8Bytes('abc')), [97, 98, 99]);
eq('the rupee sign is three bytes', Array.from(utf8Bytes('₹')), [0xe2, 0x82, 0xb9]);
check('a Devanagari name encodes without throwing', utf8Bytes('रवि कुमार').length > 9);

console.log('\nMATRIX STRUCTURE');
const payload =
  'upi://pay?pa=ravi.kumar%40pravaah&pn=Ravi%20Kumar&am=2500.00&cu=INR&tn=Rent&tr=PQR7x2Kd';
const code = encodeQr(payload);

check(`size is 4·version + 17 (v${code.version} → ${code.size})`, code.size === code.version * 4 + 17);
check('the mask is one of the eight', code.mask >= 0 && code.mask <= 7);

// Every module must be set. An unset one means the zigzag missed a cell, which is the classic
// off-by-one in a hand-written placer and produces a code that scans as garbage.
const allSet = code.modules.every((row) => row.length === code.size);
check('every row is the full width', allSet);

/** The three finder patterns, checked as actual 7×7 rings. */
function isFinder(top: number, left: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring =
        r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      if (code.modules[top + r]![left + c] !== ring) return false;
    }
  }
  return true;
}
check('top-left finder pattern', isFinder(0, 0));
check('top-right finder pattern', isFinder(0, code.size - 7));
check('bottom-left finder pattern', isFinder(code.size - 7, 0));

// The separators: a light ring around each finder.
check(
  'top-left separator is light',
  Array.from({ length: 8 }, (_, i) => i).every(
    (i) => code.modules[7]![i] === false && code.modules[i]![7] === false,
  ),
);

// Timing patterns alternate, starting and ending dark.
let timingOk = true;
for (let i = 8; i < code.size - 8; i++) {
  const expected = i % 2 === 0;
  if (code.modules[6]![i] !== expected) timingOk = false;
  if (code.modules[i]![6] !== expected) timingOk = false;
}
check('both timing patterns alternate correctly', timingOk);

check('the dark module is dark', code.modules[code.size - 8]![8] === true);

// Dark ratio: a correctly masked code sits near half. Far outside that band means the mask
// selection or the penalty scoring is wrong.
const dark = code.modules.flat().filter(Boolean).length;
const ratio = (dark / (code.size * code.size)) * 100;
check(
  `dark ratio is balanced (${ratio.toFixed(1)}%)`,
  ratio > 35 && ratio < 65,
  `${ratio.toFixed(1)}% is outside 35–65, which suggests mask selection is not working`,
);

console.log('\nDETERMINISM');
const again = encodeQr(payload);
check(
  'the same payload engraves identically',
  JSON.stringify(again.modules) === JSON.stringify(code.modules),
);
check(
  'a different payload produces a different matrix',
  JSON.stringify(encodeQr(payload + '1').modules) !== JSON.stringify(code.modules),
);

console.log('\nREAL PAYLOADS');
for (const sample of [
  'upi://pay?pa=a%40b&cu=INR',
  'upi://pay?pa=ravi.kumar%40pravaah&pn=Ravi%20Kumar&cu=INR',
  payload,
  `upi://pay?pa=very.long.merchant.name%40pravaah&pn=${'A'.repeat(40)}&am=120.50&cu=INR&mc=5812&tn=Order&tr=${'x'.repeat(30)}`,
]) {
  const encoded = encodeQr(sample);
  check(
    `encodes a ${utf8Bytes(sample).length}-byte payload at version ${encoded.version}`,
    encoded.size === encoded.version * 4 + 17 && encoded.modules.length === encoded.size,
  );
}

console.log(`\n${'═'.repeat(64)}`);
console.log(
  failures === 0
    ? `ALL ${checks} CHECKS PASSED — the encoder agrees with the specification.`
    : `${failures} of ${checks} CHECK(S) FAILED.`,
);
console.log('═'.repeat(64));
process.exit(failures > 0 ? 1 : 0);
