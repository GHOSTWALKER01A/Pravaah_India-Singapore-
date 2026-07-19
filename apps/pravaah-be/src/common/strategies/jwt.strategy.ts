import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'

import { passportJwtSecret } from 'jwks-rsa'
import { ExtractJwt, Strategy } from 'passport-jwt'

interface SupabaseJwtPayload {
  aud?: string | string[]
  app_metadata?: {
    role?: string
    [key: string]: unknown
  }
  email?: string
  iss?: string
  phone?: string
  role?: string
  sub?: string
  user_metadata?: Record<string, unknown>
  user_role?: string
  [key: string]: unknown
}

interface AuthenticatedUser extends SupabaseJwtPayload {
  id: string
  role: string
  email?: string
  phone?: string
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name)

  constructor(configService: ConfigService) {
    const supabaseUrl = configService.get<string>('SUPABASE_URL')
    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL is not defined in environment variables')
    }

    const normalizedSupabaseUrl = supabaseUrl.replace(/\/$/, '')
    const issuer = `${normalizedSupabaseUrl}/auth/v1`
    const jwksUri = `${issuer}/.well-known/jwks.json`

    const jwksProvider = passportJwtSecret({
      cache: true,
      jwksRequestsPerMinute: 5,
      jwksUri,
      rateLimit: true,
    })

    super({
      algorithms: ['ES256', 'RS256'],
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      issuer,
      secretOrKeyProvider: (
        request: unknown,
        rawJwtToken: string,
        done: (err: Error | null, secret?: string | Buffer) => void,
      ) => {
        jwksProvider(
          request,
          rawJwtToken,
          (err: Error | null, key?: string | Buffer) => {
            if (!err && key) {
              return done(null, key)
            }

            const signingKeyError =
              err ?? new Error('No signing key available from JWKS provider')

            Logger.warn(
              `[JwtStrategy] Unable to resolve signing key from ${jwksUri}: ${signingKeyError.message}`,
            )

            done(signingKeyError)
          },
        )
      },
    })
  }

  async validate(payload: SupabaseJwtPayload): Promise<AuthenticatedUser> {
    this.logger.debug(
      `[JwtStrategy] Validating payload for user_id: ${payload.sub}`,
    )

    const resolvedRole =
      payload.user_role ?? payload.app_metadata?.role ?? payload.role

    if (!payload.sub || !resolvedRole) {
      this.logger.error(
        `[JwtStrategy] Invalid token payload missing sub or role.`,
      )
      throw new UnauthorizedException(
        'Invalid token payload or missing role structure',
      )
    }

    return {
      ...payload,
      id: payload.sub,
      role: resolvedRole,
      email: payload.email,
      phone: payload.phone,
    }
  }
}
