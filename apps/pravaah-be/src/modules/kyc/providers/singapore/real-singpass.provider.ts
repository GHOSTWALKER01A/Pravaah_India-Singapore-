import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, randomBytes, randomUUID } from 'crypto'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import axios from 'axios'
import {
  SignJWT,
  base64url,
  compactDecrypt,
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose'

import {
  SINGPASS_ALGS,
  SINGPASS_ASSERTION_TTL_SECONDS,
  SINGPASS_CLIENT_ASSERTION_TYPE,
  SINGPASS_DEFAULT_SCOPES,
  SINGPASS_GRANT_TYPE,
  SINGPASS_RESPONSE_TYPE,
} from '@/config/singpass.config'
import { ENV } from '@/constants/environment.constants'

import { KycError, KycErrorCode } from '@/common/errors/kyc.errors'
import { Err, Ok, Result } from '@/common/result/result'

import {
  MyinfoResult,
  SingaporeKycProvider,
} from '@/modules/kyc/providers/singapore/singapore-kyc.provider'

type CryptoKeyLike = Awaited<ReturnType<typeof importJWK>>

interface SingpassSession {
  codeVerifier: string
  nonce: string
  code?: string
}

/**
 * Production Singpass Myinfo v4 client — NOT wired by default (the persona
 * provider is). Swap it in via one line in `kyc.module.ts`:
 *
 *   { provide: SG_KYC, useClass: RealSingpassProvider }
 *
 * Flow behind the shared {@link SingaporeKycProvider} interface:
 *   1. `initiate()`  → build the Singpass authorize URL (PKCE + nonce + state),
 *                      stash the code_verifier/nonce keyed by state.
 *   2. Singpass redirects to our callback with `?code&state`. The callback
 *      controller calls `handleCallback(state, code)` to attach the auth code
 *      (mirrors the persona provider's `bindPersona`).
 *   3. `fetch(state)` → private_key_jwt + PKCE token exchange (DPoP-bound),
 *                      then the DPoP-authorised Person API call whose JWE we
 *                      decrypt and whose inner JWS we verify against Singpass's
 *                      JWKS, before mapping attributes to MyinfoResult.
 *
 * NOTE: session state is in-memory (single instance). For multi-instance
 * deployments back it with Redis/DB keyed by `state`.
 *
 * Every crypto/endpoint detail is env- or config-driven — CONFIRM the exact
 * Myinfo v4 contract for your tenant (see src/config/singpass.config.ts).
 */
@Injectable()
export class RealSingpassProvider implements SingaporeKycProvider {
  private readonly logger: AppLogger
  private readonly sessions = new Map<string, SingpassSession>()

  // Lazily-imported keys (cached promises) so construction stays synchronous.
  private sigKeyPromise?: Promise<CryptoKeyLike>
  private encKeyPromise?: Promise<CryptoKeyLike>
  private singpassJwks?: ReturnType<typeof createRemoteJWKSet>

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: RealSingpassProvider.name })
  }

  // ── Step 1: authorize URL ────────────────────────────────────────────────
  async initiate(
    _userRef: string,
  ): Promise<{ providerRefId: string; authorizationUrl: string }> {
    const state = base64url.encode(randomBytes(24))
    const nonce = base64url.encode(randomBytes(24))
    const codeVerifier = base64url.encode(randomBytes(32))
    const codeChallenge = base64url.encode(
      createHash('sha256').update(codeVerifier).digest(),
    )

    this.sessions.set(state, { codeVerifier, nonce })

    const url = new URL(this.env(ENV.SINGPASS.AUTHORIZE_URL))
    url.searchParams.set('client_id', this.env(ENV.SINGPASS.CLIENT_ID))
    url.searchParams.set('redirect_uri', this.env(ENV.SINGPASS.REDIRECT_URI))
    url.searchParams.set('scope', this.scopes())
    url.searchParams.set('purpose_id', this.env(ENV.SINGPASS.PURPOSE_ID))
    url.searchParams.set('response_type', SINGPASS_RESPONSE_TYPE)
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)

    return { providerRefId: state, authorizationUrl: url.toString() }
  }

  /** Step 2 — attach the authorization code from the Singpass redirect. */
  handleCallback(providerRefId: string, code: string): boolean {
    const session = this.sessions.get(providerRefId)
    if (!session) return false
    session.code = code
    return true
  }

  // ── Step 3: token exchange + Person API ──────────────────────────────────
  async fetch(providerRefId: string): Promise<Result<MyinfoResult>> {
    const session = this.sessions.get(providerRefId)
    if (!session?.code) {
      return Err(
        new KycError(
          KycErrorCode.PROVIDER_REJECTED,
          'No authorization code for this session',
          false,
        ),
      )
    }

    try {
      const token = await this.exchangeCode(session.code, session.codeVerifier)
      const uinfin = this.extractUinfin(token.access_token)
      const personJwe = await this.callPerson(uinfin, token.access_token)
      const person = await this.decryptAndVerify(personJwe)
      this.sessions.delete(providerRefId)
      return Ok(this.mapPerson(uinfin, person))
    } catch (error) {
      this.logger.error(`[${this.fetch.name}] Myinfo retrieval failed`, {
        err: error,
      })
      if (error instanceof KycError) return Err(error)
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined
      const retryable = !status || status >= 500
      return Err(
        new KycError(
          retryable ? KycErrorCode.PROVIDER_DOWN : KycErrorCode.PROVIDER_REJECTED,
          'Myinfo retrieval failed',
          retryable,
          error,
        ),
      )
    }
  }

  // ── token exchange (private_key_jwt + PKCE + DPoP) ───────────────────────
  private async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const tokenUrl = this.env(ENV.SINGPASS.TOKEN_URL)
    const clientId = this.env(ENV.SINGPASS.CLIENT_ID)

    const body = new URLSearchParams({
      grant_type: SINGPASS_GRANT_TYPE,
      code,
      redirect_uri: this.env(ENV.SINGPASS.REDIRECT_URI),
      client_id: clientId,
      code_verifier: codeVerifier,
      client_assertion_type: SINGPASS_CLIENT_ASSERTION_TYPE,
      client_assertion: await this.clientAssertion(tokenUrl),
    })

    const dpop = await this.dpopProof('POST', tokenUrl)
    const res = await axios.post<TokenResponse>(tokenUrl, body.toString(), {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        DPoP: dpop,
      },
      timeout: 15_000,
    })

    if (!res.data?.access_token) {
      throw new KycError(
        KycErrorCode.PROVIDER_REJECTED,
        'Token endpoint returned no access_token',
        false,
        res.data,
      )
    }
    return res.data
  }

  // ── Person API (DPoP-bound bearer, JWE response) ─────────────────────────
  private async callPerson(
    uinfin: string,
    accessToken: string,
  ): Promise<string> {
    const personUrl = `${this.env(ENV.SINGPASS.PERSON_URL)}/${uinfin}`
    const dpop = await this.dpopProof('GET', personUrl, accessToken)

    const res = await axios.get<string>(personUrl, {
      params: { scope: this.scopes() },
      headers: {
        Authorization: `DPoP ${accessToken}`,
        DPoP: dpop,
      },
      responseType: 'text',
      timeout: 15_000,
    })
    return res.data
  }

  // ── crypto helpers ────────────────────────────────────────────────────────

  /** private_key_jwt client assertion signed with our ES256 signing key. */
  private async clientAssertion(audience: string): Promise<string> {
    const clientId = this.env(ENV.SINGPASS.CLIENT_ID)
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({})
      .setProtectedHeader({
        alg: SINGPASS_ALGS.SIGNING,
        kid: this.env(ENV.SINGPASS.SIG_KID),
        typ: 'JWT',
      })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + SINGPASS_ASSERTION_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(await this.sigKey())
  }

  /** DPoP proof JWT. Includes `ath` (access-token hash) for resource calls. */
  private async dpopProof(
    htm: 'GET' | 'POST',
    htu: string,
    accessToken?: string,
  ): Promise<string> {
    const claims: Record<string, unknown> = { htm, htu }
    if (accessToken) {
      claims.ath = base64url.encode(
        createHash('sha256').update(accessToken).digest(),
      )
    }
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: SINGPASS_ALGS.SIGNING,
        typ: 'dpop+jwt',
        jwk: this.publicSigJwk(),
      })
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(await this.sigKey())
  }

  /** Decrypt the Person JWE to us, then verify the inner Singpass JWS. */
  private async decryptAndVerify(jwe: string): Promise<PersonData> {
    const { plaintext } = await compactDecrypt(jwe, await this.encKey())
    const jws = new TextDecoder().decode(plaintext)
    const { payload } = await jwtVerify(jws, this.jwks())
    return payload as unknown as PersonData
  }

  // ── key material ────────────────────────────────────────────────────────

  private sigKey(): Promise<CryptoKeyLike> {
    this.sigKeyPromise ??= importJWK(
      this.privateJwk(ENV.SINGPASS.SIG_PRIVATE_JWK),
      SINGPASS_ALGS.SIGNING,
    )
    return this.sigKeyPromise
  }

  private encKey(): Promise<CryptoKeyLike> {
    this.encKeyPromise ??= importJWK(
      this.privateJwk(ENV.SINGPASS.ENC_PRIVATE_JWK),
      SINGPASS_ALGS.ENC_ALG,
    )
    return this.encKeyPromise
  }

  private jwks(): ReturnType<typeof createRemoteJWKSet> {
    this.singpassJwks ??= createRemoteJWKSet(
      new URL(this.env(ENV.SINGPASS.JWKS_URL)),
    )
    return this.singpassJwks
  }

  /** Public half of the signing JWK, embedded in the DPoP proof header. */
  private publicSigJwk(): JWK {
    const { kty, crv, x, y } = this.privateJwk(ENV.SINGPASS.SIG_PRIVATE_JWK)
    return { kty, crv, x, y }
  }

  private privateJwk(envKey: string): JWK {
    const raw = this.env(envKey)
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as JWK
    } catch {
      throw new KycError(
        KycErrorCode.INVALID_INPUT,
        `Malformed JWK in ${envKey} (expected base64-encoded JWK JSON)`,
        false,
      )
    }
  }

  // ── mapping ───────────────────────────────────────────────────────────────

  private extractUinfin(accessToken: string): string {
    // Myinfo v4 access-token `sub` looks like "s=SXXXXXXXXX,u=<uuid>".
    const parts = accessToken.split('.')
    if (parts.length < 2) {
      throw new KycError(
        KycErrorCode.PROVIDER_REJECTED,
        'Access token is not a JWT',
        false,
      )
    }
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { sub?: string }
    const sub = payload.sub ?? ''
    const uinfin = /(?:^|,)s=([^,]+)/.exec(sub)?.[1] ?? sub
    if (!uinfin) {
      throw new KycError(
        KycErrorCode.PROVIDER_REJECTED,
        'Could not derive UINFIN from access token',
        false,
      )
    }
    return uinfin
  }

  private mapPerson(uinfin: string, person: PersonData): MyinfoResult {
    return {
      uinfin: this.value(person.uinfin) || uinfin,
      name: this.value(person.name),
      dob: this.value(person.dob),
      nationality: this.desc(person.nationality),
      residentialAddress: this.composeAddress(person.regadd),
      employment: this.desc(person.occupation) || this.value(person.occupation),
    }
  }

  private value(field?: { value?: string }): string {
    return field?.value ?? ''
  }

  private desc(field?: { desc?: string }): string {
    return field?.desc ?? ''
  }

  private composeAddress(regadd?: RegAdd): string {
    if (!regadd) return ''
    const parts = [
      this.value(regadd.block),
      this.value(regadd.street),
      this.value(regadd.building),
      [this.value(regadd.floor), this.value(regadd.unit)]
        .filter(Boolean)
        .join('-'),
      this.value(regadd.postal),
      this.desc(regadd.country) || this.value(regadd.country),
    ].filter(Boolean)
    return parts.join(', ')
  }

  // ── config accessors ──────────────────────────────────────────────────────

  private env(key: string): string {
    return this.config.getOrThrow<string>(key)
  }

  private scopes(): string {
    return (
      this.config.get<string>(ENV.SINGPASS.SCOPES)?.trim() ||
      SINGPASS_DEFAULT_SCOPES.join(' ')
    )
  }
}

interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  [key: string]: unknown
}

type CodedField = { code?: string; desc?: string; value?: string }
type ValueField = { value?: string }

interface RegAdd {
  block?: ValueField
  building?: ValueField
  floor?: ValueField
  unit?: ValueField
  street?: ValueField
  postal?: ValueField
  country?: CodedField
}

interface PersonData {
  uinfin?: ValueField
  name?: ValueField
  dob?: ValueField
  nationality?: CodedField
  regadd?: RegAdd
  occupation?: CodedField
  [key: string]: unknown
}
