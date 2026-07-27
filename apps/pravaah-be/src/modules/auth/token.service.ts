import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import { SignJWT, jwtVerify } from 'jose'

import { ENV } from '@/constants/environment.constants'

const ISSUER = 'pravaah'
const AUDIENCE = 'pravaah-app'
const ACCESS_TTL = '12h'
const REFRESH_TTL = '30d'

export interface SessionClaims {
  sub: string
  phone?: string | null
  role?: string
}

export interface SessionTokens {
  accessToken: string
  refreshToken: string
}

/**
 * Issues and verifies our own HS256 session JWTs. Once Twilio has verified the
 * OTP, we own the session — no Supabase involved. Access tokens are validated
 * by {@link JwtStrategy}; refresh tokens are validated here.
 */
@Injectable()
export class TokenService {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: TokenService.name })
  }

  async issueSession(claims: SessionClaims): Promise<SessionTokens> {
    const accessToken = await this.sign(
      { typ: 'access', role: claims.role ?? 'user', phone: claims.phone ?? undefined },
      claims.sub,
      ACCESS_TTL,
    )
    const refreshToken = await this.sign(
      { typ: 'refresh', role: claims.role ?? 'user', phone: claims.phone ?? undefined },
      claims.sub,
      REFRESH_TTL,
    )
    return { accessToken, refreshToken }
  }

  /** Verify a refresh token and mint a fresh access+refresh pair. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    let payload: Record<string, unknown>
    try {
      const verified = await jwtVerify(refreshToken, this.secret(), {
        issuer: ISSUER,
        audience: AUDIENCE,
      })
      payload = verified.payload
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token')
    }
    if (payload.typ !== 'refresh' || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Invalid refresh token')
    }
    return this.issueSession({
      sub: payload.sub,
      phone: typeof payload.phone === 'string' ? payload.phone : null,
      role: typeof payload.role === 'string' ? payload.role : undefined,
    })
  }

  private sign(
    claims: Record<string, unknown>,
    subject: string,
    ttl: string,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.secret())
  }

  private secret(): Uint8Array {
    return new TextEncoder().encode(
      this.config.getOrThrow<string>(ENV.JWT.SECRET),
    )
  }
}
