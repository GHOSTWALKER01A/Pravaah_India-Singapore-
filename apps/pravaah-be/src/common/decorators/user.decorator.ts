import { createParamDecorator, ExecutionContext } from '@nestjs/common'

/**
 * Shape attached to `request.user` by {@link JwtStrategy.validate}. `id` is the
 * Supabase auth user id (`sub`), which is also the primary key `User.id`.
 */
export interface AuthenticatedUser {
  id: string
  role: string
  email?: string
  phone?: string
}

export const User = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>()
    return request.user
  },
)
