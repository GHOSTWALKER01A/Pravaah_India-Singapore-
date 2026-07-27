import {
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport'

interface RequestMeta {
  method?: string
  originalUrl?: string
  url?: string
}

/**
 * Validates the Supabase-issued JWT (via the passport `jwt` strategy) and
 * attaches the authenticated user to `request.user`.
 *
 * Passport surfaces failures in three different shapes (`err`, a falsy `user`,
 * or an `info` error such as `TokenExpiredError`). This guard collapses them
 * into a single logged 401 with a precise, client-safe reason, and always
 * re-throws the original error when one exists so nothing is swallowed.
 */
@Injectable()
export class AuthGuard extends PassportAuthGuard('jwt') {
  private readonly logger = new Logger(AuthGuard.name)

  handleRequest<TUser = Record<string, unknown>>(
    err: Error | null,
    user: TUser | false | null,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    if (err || !user) {
      const req = context.switchToHttp().getRequest<RequestMeta>()
      const route = `${req.method ?? 'UNKNOWN'} ${
        req.originalUrl ?? req.url ?? 'UNKNOWN_URL'
      }`
      const reason = this.resolveReason(info)

      this.logger.warn(
        `[handleRequest] Auth failed for ${route}: ${err?.message ?? reason}`,
      )

      // Preserve a real upstream error; otherwise raise a precise 401.
      throw err ?? new UnauthorizedException(reason, { cause: status })
    }

    return user
  }

  /** Map passport's `info` to a precise, non-leaky client message. */
  private resolveReason(info: unknown): string {
    const name = this.errorName(info)
    switch (name) {
      case 'TokenExpiredError':
        return 'Access token expired'
      case 'JsonWebTokenError':
        return 'Invalid access token'
      case 'NotBeforeError':
        return 'Access token not yet valid'
      default:
        return this.errorMessage(info) ?? 'Unauthorized'
    }
  }

  private errorName(info: unknown): string | undefined {
    if (info instanceof Error) return info.name
    if (
      typeof info === 'object' &&
      info !== null &&
      'name' in info &&
      typeof (info as { name: unknown }).name === 'string'
    ) {
      return (info as { name: string }).name
    }
    return undefined
  }

  private errorMessage(info: unknown): string | undefined {
    if (info instanceof Error && info.message) return info.message
    if (
      typeof info === 'object' &&
      info !== null &&
      'message' in info &&
      typeof (info as { message: unknown }).message === 'string'
    ) {
      return (info as { message: string }).message
    }
    return undefined
  }
}
