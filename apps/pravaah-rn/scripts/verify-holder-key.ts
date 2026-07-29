/**
 * Holder-key self-check — proves the WALLET's crypto against the BACKEND's verifier.
 *
 *   npx tsx scripts/verify-holder-key.ts
 *
 * The holder key is what makes a stolen credential inert, so "it looked right" is not an
 * acceptable standard for it. This drives `holder-crypto.ts` — the exact module the app
 * ships — and checks its output with `node:crypto`, which is the very primitive
 * `VerificationService.verifyKeyBinding` uses. If a signature passes here, `/verify` accepts
 * it; if the framing drifts, this fails instead of a user failing at a counter.
 *
 * Five things are verified, each a real way this could be silently wrong:
 *
 *   1. base64url is unpadded, url-safe, and byte-exact against Node's own encoder.
 *   2. The public JWK's coordinates are the true affine x and y of the secret's point.
 *   3. The signature is 64-byte raw r‖s, NOT ASN.1/DER — the interop bug that verifies
 *      locally and is rejected by every conformant verifier.
 *   4. `node:crypto` accepts the signature under the derived JWK.
 *   5. A tampered payload, and a signature from a different key, are both rejected.
 *
 * This file imports no Expo modules, which is the whole reason `holder-crypto.ts` was split
 * from `holder-key.ts`: the storage layer's `expo-secure-store` import would make the module
 * unloadable outside a device, and every claim about the crypto would stay untested.
 */
import {
  createPublicKey,
  randomBytes,
  verify as nodeVerify,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildKeyBindingJwt,
  bytesToB64u,
  isValidSecret,
  publicJwkFromSecret,
  SECRET_BYTES,
  stringToB64u,
} from '../src/features/passport/holder-crypto';

let failures = 0;

function check(label: string, passed: boolean, detail?: unknown): void {
  if (passed) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

/** Stands in for `expo-crypto`'s platform CSPRNG. */
function entropy(length = SECRET_BYTES): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

console.log('PRAVAAH · M3 holder-key self-check (wallet crypto vs. backend verifier)');

// ── 0. dependency resolution, the way METRO does it ─────────────────────────
section('0 · Dependency resolution (Metro’s flat lookup, not Node’s)');
{
  /**
   * This section exists because everything below it once passed while the device failed.
   *
   * Node resolves a package's dependencies HIERARCHICALLY — `@noble/curves` finds its own
   * nested `@noble/hashes`, so the crypto works here. Metro, with
   * `disableHierarchicalLookup: true` in `metro.config.js` (set deliberately, to guarantee a
   * single React), resolves ONLY from `resolver.nodeModulesPaths`. Those are flat, so
   * `@noble/curves` gets whichever `@noble/hashes` sits in the app or the workspace root.
   *
   * When that was 1.8.0 while curves 2.2.0 required 2.2.0, `getPublicKey` threw on device and
   * the wallet reported "Could not create a secure key" — with every check below still green.
   * So a Node-only test CANNOT catch this class of bug, and this check is the one that can.
   */
  const metroPaths = [
    resolve(__dirname, '..', 'node_modules'),
    resolve(__dirname, '..', '..', '..', 'node_modules'),
  ];

  const curvesPkg = JSON.parse(
    readFileSync(
      resolve(__dirname, '..', '..', '..', 'node_modules', '@noble', 'curves', 'package.json'),
      'utf8',
    ),
  ) as { version: string; dependencies?: Record<string, string> };
  const required = curvesPkg.dependencies?.['@noble/hashes'];

  // Whichever path Metro searches FIRST and finds a copy in, wins.
  let resolved: { version: string; dir: string } | null = null;
  for (const base of metroPaths) {
    const pkgPath = resolve(base, '@noble', 'hashes', 'package.json');
    if (!existsSync(pkgPath)) continue;
    const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    if (!resolved) resolved = { version, dir: base };
  }

  check('@noble/hashes is resolvable on a Metro path', resolved !== null);
  check(
    `Metro resolves @noble/hashes ${resolved?.version ?? '?'}, curves ${curvesPkg.version} requires ${required}`,
    !!resolved && !!required && resolved.version === required,
    { resolved, required },
  );
  // The specific symbol whose absence broke it: hashes 1.8.0 does not export `abytes`.
  if (resolved) {
    const utils = readFileSync(
      resolve(resolved.dir, '@noble', 'hashes', 'utils.js'),
      'utf8',
    );
    check(
      'that copy exports `abytes` (curves 2.x imports it by name)',
      /export function abytes/.test(utils),
    );
  }
}

// ── 1. base64url ────────────────────────────────────────────────────────────
section('1 · base64url');
{
  // Byte-exact against Node, across every tail length, so the 1-byte and 2-byte
  // no-padding branches are both exercised rather than assumed.
  let allMatch = true;
  for (let length = 1; length <= 64; length += 1) {
    const bytes = entropy(length);
    const mine = bytesToB64u(bytes);
    const theirs = Buffer.from(bytes).toString('base64url');
    if (mine !== theirs) {
      allMatch = false;
      check(`length ${length} matches Node`, false, { mine, theirs });
      break;
    }
  }
  check('byte-exact against Node for every tail length (1–64 bytes)', allMatch);

  const encoded = bytesToB64u(Uint8Array.from([0xfb, 0xff, 0xbf]));
  check('emits no padding', !encoded.includes('='));
  check(
    'emits no non-url characters',
    !encoded.includes('+') && !encoded.includes('/'),
    encoded,
  );
  check(
    'UTF-8 multi-byte text survives the round trip',
    Buffer.from(stringToB64u('Ashā · 日本'), 'base64url').toString('utf8') ===
      'Ashā · 日本',
  );
  check('an empty input encodes to an empty string', bytesToB64u(new Uint8Array(0)) === '');
}

// ── 2. the public JWK ───────────────────────────────────────────────────────
section('2 · Public key derivation');
const secret = entropy();
const jwk = publicJwkFromSecret(secret);
{
  check('reports a valid secret as valid', isValidSecret(secret));
  check('rejects a wrong-length secret', !isValidSecret(entropy(31)));
  check(
    'rejects an all-zero scalar (not a valid private key)',
    !isValidSecret(new Uint8Array(SECRET_BYTES)),
  );
  check('coordinates are 43 base64url characters (32 bytes)', jwk.x.length === 43 && jwk.y.length === 43);

  // The real check: Node re-derives the SAME coordinates from the same secret. If our SEC1
  // slicing were off by a byte, this is where it would surface.
  const nodeJwk = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: Buffer.from(secret).toString('base64url'),
      x: jwk.x,
      y: jwk.y,
    },
    format: 'jwk',
  }).export({ format: 'jwk' }) as { x: string; y: string };
  check(
    'x and y are the true affine coordinates of the secret’s point',
    nodeJwk.x === jwk.x && nodeJwk.y === jwk.y,
  );
}

// ── 3–4. the Key Binding JWT ────────────────────────────────────────────────
section('3 · Key Binding JWT');
const kbJwt = buildKeyBindingJwt(secret, {
  audience: 'acme-bank',
  nonce: 'nonce-0123456789abcdef',
  sdHash: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo',
  issuedAt: 1_700_000_000,
});
const [headerB64, payloadB64, signatureB64] = kbJwt.split('.');
{
  check('is a three-segment compact JWS', kbJwt.split('.').length === 3);

  const header = JSON.parse(
    Buffer.from(headerB64!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  check('header declares ES256', header.alg === 'ES256');
  check(
    'header declares typ kb+jwt (the backend rejects anything else)',
    header.typ === 'kb+jwt',
  );

  const payload = JSON.parse(
    Buffer.from(payloadB64!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  check(
    'payload commits to aud, nonce and sd_hash',
    payload.aud === 'acme-bank' &&
      payload.nonce === 'nonce-0123456789abcdef' &&
      payload.sd_hash === 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo',
  );
  check('payload carries iat', payload.iat === 1_700_000_000);

  const signature = Buffer.from(signatureB64!, 'base64url');
  // THE interop check. DER is 70–72 bytes and starts with 0x30; raw r‖s for P-256 is exactly
  // 64. A DER signature verifies against our own code and is rejected by every conformant
  // verifier, so this would pass a naive test suite and fail in production.
  check('signature is 64-byte raw r‖s, not ASN.1/DER', signature.length === 64);
  check('signature does not begin with the DER SEQUENCE tag', signature[0] !== 0x30);
}

section('4 · The backend’s verifier accepts it');
const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
{
  const accepted = nodeVerify(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureB64!, 'base64url'),
  );
  check('node:crypto verifies the wallet’s signature', accepted);
}

// ── 5. the negative cases ───────────────────────────────────────────────────
section('5 · Forgeries are rejected');
{
  const forgedPayload = stringToB64u(
    JSON.stringify({
      iat: 1_700_000_000,
      aud: 'acme-bank',
      nonce: 'nonce-0123456789abcdef',
      sd_hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }),
  );
  const tampered = nodeVerify(
    'sha256',
    Buffer.from(`${headerB64}.${forgedPayload}`, 'ascii'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureB64!, 'base64url'),
  );
  check('a swapped sd_hash fails verification', !tampered);

  // A different device signing the same bytes: the stolen-credential case.
  const thiefSecret = entropy();
  const thiefJwt = buildKeyBindingJwt(thiefSecret, {
    audience: 'acme-bank',
    nonce: 'nonce-0123456789abcdef',
    sdHash: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo',
    issuedAt: 1_700_000_000,
  });
  const [tHeader, tPayload, tSig] = thiefJwt.split('.');
  const wrongKey = nodeVerify(
    'sha256',
    Buffer.from(`${tHeader}.${tPayload}`, 'ascii'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(tSig!, 'base64url'),
  );
  check('another device’s signature fails against this holder’s key', !wrongKey);

  // Determinism: noble uses RFC 6979, so the same inputs must produce the same signature.
  // A non-deterministic signature is not wrong, but it would mean a silent dependency
  // change, and this is where we would want to notice.
  const repeat = buildKeyBindingJwt(secret, {
    audience: 'acme-bank',
    nonce: 'nonce-0123456789abcdef',
    sdHash: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo',
    issuedAt: 1_700_000_000,
  });
  check('signing is deterministic (RFC 6979)', repeat === kbJwt);
}

console.log(`\n${'═'.repeat(58)}`);
console.log(
  failures === 0
    ? 'ALL CHECKS PASSED — the wallet’s proofs will verify at /verify.'
    : `${failures} CHECK(S) FAILED.`,
);
console.log('═'.repeat(58));
process.exit(failures > 0 ? 1 : 0);
