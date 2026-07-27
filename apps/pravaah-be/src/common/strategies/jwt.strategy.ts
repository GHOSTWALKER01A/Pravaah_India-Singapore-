import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'

import { ExtractJwt, Strategy } from 'passport-jwt'

import { ENV } from '@/constants/environment.constants'

/** Claims in our own session access token (issued by TokenService). */
interface SessionJwtPayload {
  sub?: string
  role?: string
  phone?: string
  typ?: string
  [key: string]: unknown
}

interface AuthenticatedUser {
  id: string
  role: string
  phone?: string
  email?: string
}

const ISSUER = 'pravaah'
const AUDIENCE = 'pravaah-app'

/**
 * Validates our own HS256 session JWTs (minted by TokenService after Twilio
 * verifies the OTP). Symmetric secret — no Supabase/JWKS involved.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name)

  constructor(configService: ConfigService) {
    const secret = configService.get<string>(ENV.JWT.SECRET)
    if (!secret) {
      throw new Error('AUTH_JWT_SECRET is not defined in environment variables')
    }

    super({
      algorithms: ['HS256'],
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('access_token'),
      ]),
      ignoreExpiration: false,
      issuer: ISSUER,
      audience: AUDIENCE,
      secretOrKey: secret,
    })
  }

  validate(payload: SessionJwtPayload): AuthenticatedUser {
    if (!payload.sub || payload.typ !== 'access') {
      this.logger.warn('[validate] Rejecting token: missing sub or not an access token')
      throw new UnauthorizedException('Invalid access token')
    }
    return {
      id: payload.sub,
      role: payload.role ?? 'user',
      phone: payload.phone,
    }
  }
}
