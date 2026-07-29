import { z } from 'zod'

import { normalizePravaahId } from '../../common/pravaah-id'

/**
 * Peer verification — one holder checking another, with no partner in between.
 *
 * ── Why this file exists at all ──
 * Every other verifier in M3 is a registered `VerifierPartner` with an API key and an
 * `audience`, and that is not bureaucracy: the KB-JWT is made out to ONE audience, and
 * that binding is the only thing stopping a presentation captured at one verifier being
 * replayed at another. An anonymous or self-declared audience would turn the strongest
 * replay defence in the credential into a field the attacker fills in.
 *
 * A person scanning another person's passport therefore cannot simply be "no audience".
 * They need an identifier that is:
 *
 *   stable      — the same person is the same audience next week, so a holder's share
 *                 history says something true;
 *   public      — it can be printed in the holder's consent prompt and their history;
 *   unforgeable by typo — a mistyped one must fail rather than resolve to a stranger;
 *   NOT a secret — it travels inside a signed proof that the other side keeps.
 *
 * The Pravaah ID is exactly that, and it already exists. So a peer's audience is their
 * Pravaah ID under a reserved scheme. The scheme prefix is what keeps the two namespaces
 * from ever colliding: a partner audience is a domain or a slug the partner chose, and
 * without a prefix a partner could register `PVH-...` as their own audience and receive
 * presentations meant for a person.
 */

/**
 * The reserved scheme. A colon-delimited prefix rather than a bare ID, so
 * {@link isPeerAudience} is a total function on any audience string in the system.
 */
export const PEER_AUDIENCE_SCHEME = 'pravaah:peer'

/** Build the audience a peer verifier presents as. Returns null for an invalid ID. */
export function peerAudience(pravaahId: string): string | null {
  const canonical = normalizePravaahId(pravaahId)
  return canonical ? `${PEER_AUDIENCE_SCHEME}:${canonical}` : null
}

/** True when an audience belongs to a person rather than a registered partner. */
export function isPeerAudience(audience: string): boolean {
  return audience.startsWith(`${PEER_AUDIENCE_SCHEME}:`)
}

/**
 * Recover the Pravaah ID from a peer audience.
 *
 * Re-normalised on the way out rather than trusted: this string round-trips through the
 * database and a signed JWT, and an audience that merely LOOKS like a peer one must not
 * become a lookup key without its checksum being re-checked.
 */
export function peerAudienceHolder(audience: string): string | null {
  if (!isPeerAudience(audience)) return null
  return normalizePravaahId(audience.slice(PEER_AUDIENCE_SCHEME.length + 1))
}

/**
 * Body for `POST /passport/scan` — a user handing over whatever their camera read.
 *
 * The payload is the RAW scanned string and it is parsed server-side, for the same reason
 * the payments scanner parses server-side: whoever printed the code chose every byte of
 * it, and two parsers that disagree about a malformed one are two different answers to
 * "whose passport is this".
 */
export const PeerScanSchema = z.object({
  payload: z.string().trim().min(4).max(4096),
  /**
   * How long the holder has to answer.
   *
   * Short by default. A peer check happens with both people present, so a request that
   * outlives the conversation is a request the holder may approve later with no memory of
   * who asked — which is consent in form and not in substance.
   */
  ttlSeconds: z.number().int().min(30).max(600).default(180),
})
export type PeerScanDto = z.infer<typeof PeerScanSchema>

/** What a scanned code turned out to be. */
export const PEER_SCAN_KINDS = ['PASSPORT', 'NOT_PASSPORT'] as const
export type PeerScanKind = (typeof PEER_SCAN_KINDS)[number]
