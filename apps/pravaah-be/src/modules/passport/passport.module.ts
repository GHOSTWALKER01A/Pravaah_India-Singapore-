import { Module } from '@nestjs/common'
import { PassportModule as NestPassportModule } from '@nestjs/passport'
import { ThrottlerModule } from '@nestjs/throttler'

import { JwtStrategy } from '@/common/strategies/jwt.strategy'
import { PartnerApiKeyGuard } from '@/common/guards/partner-api-key.guard'

import { AdminPassportController } from '@/modules/passport/admin-passport.controller'
import { PassportConfig } from '@/modules/passport/passport.config'
import { PassportController } from '@/modules/passport/passport.controller'
import { TrustAnchorController } from '@/modules/passport/trust-anchor.controller'
import { VerifyController } from '@/modules/passport/verify.controller'
import { CardService } from '@/modules/passport/services/card.service'
import { IssuerService } from '@/modules/passport/services/issuer.service'
import { KeyManagementService } from '@/modules/passport/services/key-management.service'
import { PassportAdminService } from '@/modules/passport/services/passport-admin.service'
import { PassportLifecycleService } from '@/modules/passport/services/passport-lifecycle.service'
import { PeerVerifyService } from '@/modules/passport/services/peer-verify.service'
import { PresentationService } from '@/modules/passport/services/presentation.service'
import { RevocationService } from '@/modules/passport/services/revocation.service'
import { VerificationService } from '@/modules/passport/services/verification.service'
import { VerifierSessionService } from '@/modules/passport/services/verifier-session.service'

/**
 * M3 — The Passport (Verifiable Credential layer).
 *
 * M2 produced an explainable score that lives in OUR database. M3 issues it to the
 * user as a credential THEY own: an SD-JWT VC that is cryptographically signed,
 * tamper-evident, selectively disclosable, revocable, and verifiable offline by anyone
 * in either country.
 *
 * Account Aggregator and SGFinDex give regulated data PORTABILITY. Nobody gives the
 * user a portable, owned, presentable reputation ARTEFACT. That gap is what this module
 * occupies, and every design decision inside it follows from four properties:
 *
 *  - ISSUER SIGNATURE + a resolvable `did:web` — borderless trust with no bilateral
 *    agreement. {@link KeyManagementService} is our analogue of the ICAO PKD.
 *  - HOLDER KEY BINDING — possession of the credential is not the ability to present
 *    it. The private key lives in the device keystore and never reaches us, so a stolen
 *    credential (or a stolen copy of our database) is inert.
 *  - SELECTIVE DISCLOSURE — salted per-claim digests, so a domestic micro-loan sees one
 *    boolean and a cross-border landlord sees five fields, from the same credential.
 *  - STATUS-LIST REVOCATION — one bit per credential, published whole, so a verifier
 *    checks revocation offline and we never learn who is being checked.
 *
 * Unlike M0/M1/M2 there is no provider-swap registry here, and deliberately so: the
 * "provider" of a verifiable credential is a STANDARD, not a vendor. The SD-JWT VC
 * format, `did:web`, and Bitstring Status List are the interchangeable parts, and they
 * are implemented directly on `node:crypto` (see `crypto/jose.util.ts` for why not
 * `jose`).
 *
 * Depends on M0 (a VERIFIED identity, and the optional real-passport binding) and M2 (a
 * COMPUTED score). Feeds M7 (the partner console verifies through
 * {@link VerificationService}) and M4/M5 (a lender or insurer trusts the result to
 * disburse credit or price cover).
 */
@Module({
  imports: [
    NestPassportModule,
    /**
     * Rate limiting for the public verify surface.
     *
     * Registered HERE rather than globally, and this is load-bearing: the app has no
     * global ThrottlerModule, so a `@Throttle()` decorator anywhere else in the codebase
     * is inert metadata that merely LOOKS like a limit. Scoping it to this module also
     * avoids silently imposing a new limit on the auth and KYC routes, which were built
     * without one.
     *
     * `/verify` runs an elliptic-curve verification per call, so an unbounded endpoint is
     * a cheap way to spend our CPU. The per-route `@Throttle()` values override this
     * default; this entry is what makes the guard functional at all.
     */
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
    }),
  ],
  controllers: [
    // Holder-facing wallet API (JWT-guarded).
    PassportController,
    // Partner-facing verification API (partner API key).
    VerifyController,
    // Unauthenticated trust anchor: did.json, JWKS, VCT metadata, status lists.
    TrustAnchorController,
    // Admin console (admin JWT + RBAC).
    AdminPassportController,
  ],
  providers: [
    PassportConfig,

    // trust anchor + revocation
    KeyManagementService,
    RevocationService,

    // issue → hold → present → verify
    IssuerService,
    PresentationService,
    VerificationService,
    VerifierSessionService,
    /**
     * Person-to-person verification.
     *
     * Sits beside VerifierSessionService rather than inside it because the two differ in
     * the one dimension that matters: WHO the audience is. A partner's audience is a
     * registered string behind an API key; a peer's is their own Pravaah ID. Folding them
     * together would put an end-user code path inside the class the partner guard
     * protects, which is the mistake that ends with a user naming their own audience.
     */
    PeerVerifyService,

    // physical companion card
    CardService,

    // admin oversight + safety nets
    PassportAdminService,
    PassportLifecycleService,

    PartnerApiKeyGuard,
    JwtStrategy,
  ],
  // M7's partner console verifies through VerificationService, and M4/M5 read a
  // credential's status before disbursing — both go through these services rather than
  // the Credential table, so the verification rules stay in one place.
  exports: [VerificationService, KeyManagementService, RevocationService],
})
export class PassportModule {}
