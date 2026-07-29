import { Controller, Get, Param, Version, VERSION_NEUTRAL } from '@nestjs/common'

import { PASSPORT_VCT_PATH } from '@pravaah/schema'

import { PassportConfig } from '@/modules/passport/passport.config'
import {
  STATUS_LIST_ROUTES,
  WELL_KNOWN_ROUTES,
} from '@/modules/passport/passport.route'
import {
  ALWAYS_VISIBLE_CLAIMS,
  CLAIM_CATALOGUE,
  DISCLOSABLE_CLAIMS,
} from '@pravaah/schema'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'

/**
 * The trust anchor: the documents a stranger's verifier fetches to verify a Pravaah
 * passport without ever talking to us.
 *
 * `@Version(VERSION_NEUTRAL)` and a bare path are load-bearing, not stylistic.
 * `did:web:pravaah.app` resolves, by specification, to
 * `https://pravaah.app/.well-known/did.json` — the DID has no room for a version
 * segment. A DID document served at `/api/v1/.well-known/did.json` is a DID nobody in
 * the world can resolve, which would quietly reduce our credentials to something only
 * we can verify. That would remove the entire point of M3.
 *
 * These responses are also the one place in the API that does NOT use the
 * `{ success, data }` envelope: the DID and JWKS formats are fixed by their specs, and
 * a wrapper would make a standards-compliant client fail to parse them.
 */
@Controller()
export class TrustAnchorController {
  constructor(
    private readonly keys: KeyManagementService,
    private readonly revocation: RevocationService,
    private readonly config: PassportConfig,
  ) {}

  /** The `did:web` document. Lists EVERY non-retired key, not just the active one. */
  @Get(WELL_KNOWN_ROUTES.DID)
  @Version(VERSION_NEUTRAL)
  did(): Promise<Record<string, unknown>> {
    return this.keys.didDocument()
  }

  /** The JWKS, for verifiers that prefer a plain key set to DID resolution. */
  @Get(WELL_KNOWN_ROUTES.JWKS)
  @Version(VERSION_NEUTRAL)
  jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
    return this.keys.jwks()
  }

  /**
   * SD-JWT VC type metadata, discoverable from the credential's own `vct` claim.
   *
   * This is what lets a wallet that has never seen a Pravaah credential render it with
   * real labels instead of raw claim keys — the `vct` is a URL, and this is what is at
   * the other end of it.
   */
  @Get(WELL_KNOWN_ROUTES.VCT)
  @Version(VERSION_NEUTRAL)
  vct(): Record<string, unknown> {
    return {
      vct: this.config.vct(),
      name: 'Financial Reputation Passport',
      description:
        'A portable, user-owned reputation credential issued by PRAVAAH from regulated financial data. Carries a derived score and its provenance — never raw financial records.',
      // Machine-readable claim descriptions, in the shape the SD-JWT VC type-metadata
      // draft defines: a display path plus a label per claim.
      claims: [
        ...ALWAYS_VISIBLE_CLAIMS.map((claim) => ({
          path: [claim],
          display: [{ lang: 'en-IN', label: humanise(claim) }],
          sd: 'never' as const,
        })),
        ...DISCLOSABLE_CLAIMS.map((claim) => ({
          path: [claim],
          display: [
            {
              lang: 'en-IN',
              label: CLAIM_CATALOGUE[claim].label,
              description: CLAIM_CATALOGUE[claim].detail,
            },
          ],
          sd: 'allowed' as const,
        })),
      ],
      display: [
        {
          lang: 'en-IN',
          name: 'Financial Reputation Passport',
          rendering: {
            simple: {
              background_color: '#0B1F3A',
              text_color: '#F5F7FA',
            },
          },
        },
      ],
    }
  }

  /**
   * A published status list.
   *
   * Versioned (so it sits under `api/v1` alongside everything else) because the URI is
   * embedded in credentials we mint and is therefore ours to choose — unlike the DID
   * document, whose location is dictated by the DID method.
   */
  @Get(`${STATUS_LIST_ROUTES.BASE}/${STATUS_LIST_ROUTES.LIST}`)
  async statusList(@Param('listId') listId: string): Promise<
    Record<string, unknown>
  > {
    const published = await this.revocation.publish(listId)
    return {
      // The signed form first: a verifier that only reads this is safe by default,
      // because tampering with the plaintext copy below would not survive the
      // signature check.
      signedStatusListCredential: published.signedJwt,
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      issuer: this.config.did(),
      credentialSubject: published.credentialSubject,
      version: published.version,
      updatedAt: published.updatedAt,
    }
  }
}

/** `credential_number` → `Credential number`. Only for the always-visible claims. */
function humanise(claim: string): string {
  const spaced = claim.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// Re-exported so the VCT path used to build the route and the one baked into the
// credential can never drift apart.
export { PASSPORT_VCT_PATH }
