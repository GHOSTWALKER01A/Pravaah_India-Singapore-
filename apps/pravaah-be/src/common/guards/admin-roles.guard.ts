import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { ADMIN_ROLES_KEY } from '@/common/decorators/admin-roles.decorator'

import type { AdminRole, AdminUser } from 'generated/prisma/client'

/**
 * RBAC for the admin console. Runs after {@link AdminAuthGuard} has populated
 * `req.admin`. A route with no `@AdminRoles(...)` is open to any authenticated
 * admin.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    )
    if (!required || required.length === 0) return true

    const { admin } = ctx
      .switchToHttp()
      .getRequest<{ admin?: AdminUser }>()

    if (!admin || !required.includes(admin.role)) {
      throw new ForbiddenException('Insufficient reviewer role')
    }
    return true
  }
}
