import { p256 } from '@noble/curves/nist.js';

/**
 * The holder key's PURE crypto — base64url, the P-256 public key, and the Key Binding JWT.
 *
 * Split out from `holder-key.ts` deliberately, and the split is what makes this code
 * trustworthy rather than merely plausible: this file imports NO Expo modules, so it runs
 * unchanged under Node. `scripts/verify-holder-key.ts` drives it against `node:crypto` — the
 * very verifier the backend uses — and proves the signatures we produce here are the ones
 * `/verify` will accept.
 *
 * Without that split, every claim about this crypto would be untested, because the storage
 * layer's `expo-secure-store` import makes the module unloadable outside a device.
 *
 * The secret scalar is passed IN as an argument and never held here. Storage, entropy, and
 * the key's lifetime belong to `holder-key.ts`; this file is a set of pure functions over
 * bytes.
 */

/** A P-256 secret scalar is 32 bytes. */
export const SECRET_BYTES = 32;

/**
 * A type alias rather than an interface, matching the backend's `EcPublicJwk`: only aliases
 * get TypeScript's implicit index signature, which is what lets this be handed straight to a
 * `JsonWebKey` parameter (as the self-check script does with `node:crypto`) without a cast.
 */
export type HolderPublicJwk = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
};

// ── base64url ───────────────────────────────────────────────────────────────
const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Encode bytes as unpadded base64url.
 *
 * Hand-rolled rather than using `btoa`, for three concrete reasons: `btoa` is not guaranteed
 * present in Hermes; it takes a binary STRING, so every byte would need a lossy round-trip
 * through `String.fromCharCode`; and it emits `+`, `/` and `=`, none of which may appear in
 * a JWS. Twenty lines here removes a whole class of "works in the simulator" failure.
 */
export function bytesToB64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    // The two `break`s are what produce an UNPADDED encoding: a 1-byte tail emits two
    // characters and a 2-byte tail three, rather than padding to four with '='.
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** UTF-8 encode, then base64url. Used for the JWS header and payload segments. */
export function stringToB64u(value: string): string {
  return bytesToB64u(new TextEncoder().encode(value));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── keys ────────────────────────────────────────────────────────────────────
/**
 * Derive the public JWK from a secret scalar.
 *
 * Uncompressed SEC1 (`0x04 ‖ x(32) ‖ y(32)`) because a JWK wants the affine coordinates
 * separately, and the two 32-byte halves are exactly that. Throws when the scalar is out of
 * range — which is the validation `holder-key.ts` relies on at generation time.
 */
export function publicJwkFromSecret(secret: Uint8Array): HolderPublicJwk {
  const uncompressed = p256.getPublicKey(secret, false);
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64u(uncompressed.slice(1, 33)),
    y: bytesToB64u(uncompressed.slice(33, 65)),
  };
}

/** True when `secret` is a usable P-256 scalar. Used to reject bad entropy at generation. */
export function isValidSecret(secret: Uint8Array): boolean {
  if (secret.length !== SECRET_BYTES) return false;
  try {
    p256.getPublicKey(secret, false);
    return true;
  } catch {
    return false;
  }
}

// ── the Key Binding JWT ─────────────────────────────────────────────────────
export interface KeyBindingInput {
  /** The verifier's identifier. Must match the `aud` the verifier checks. */
  audience: string;
  /** The verifier's single-use challenge. */
  nonce: string;
  /**
   * The digest committing to the EXACT credential + disclosure bytes being presented, from
   * `POST /passport/challenge`.
   *
   * Taken from the server rather than computed here on purpose: it covers the credential
   * plus the disclosures in the precise order they will be sent, and reproducing that
   * framing client-side means reproducing our claim ordering, separator handling and ASCII
   * encoding — three chances to produce a proof rejected at the counter for a reason the
   * user cannot act on. The private key still never leaves the device, which is the part
   * that carries the security.
   */
  sdHash: string;
  /** Injected so tests can pin a timestamp. Defaults to now. */
  issuedAt?: number;
}

/**
 * Build and sign a Key Binding JWT.
 *
 * The moment the holder proves, cryptographically, that the passport is theirs. The proof
 * commits to three things at once — the verifier (`aud`), the exchange (`nonce`), and the
 * exact claims revealed (`sd_hash`) — so it cannot be relayed to another verifier, replayed
 * at the same one, or reused over a substituted disclosure set.
 */
export function buildKeyBindingJwt(
  secret: Uint8Array,
  input: KeyBindingInput,
): string {
  const header = stringToB64u(JSON.stringify({ alg: 'ES256', typ: 'kb+jwt' }));
  const payload = stringToB64u(
    JSON.stringify({
      iat: input.issuedAt ?? Math.floor(Date.now() / 1000),
      aud: input.audience,
      nonce: input.nonce,
      sd_hash: input.sdHash,
    }),
  );
  const signingInput = `${header}.${payload}`;

  const signature = p256.sign(
    new TextEncoder().encode(signingInput),
    secret,
    // Both options are explicit rather than left to the defaults, because both are
    // load-bearing and silently wrong if they ever change: `prehash` makes this SHA-256 —
    // the "256" in ES256 — and `compact` is the raw r‖s a JWS requires. A DER signature is
    // what a naive implementation emits and what every conformant verifier rejects.
    { prehash: true, format: 'compact' },
  );

  return `${signingInput}.${bytesToB64u(signature)}`;
}
