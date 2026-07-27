import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport'

import { PrismaService } from '@/modules/database/prisma/prisma.service'
import {
  activeAdminWhere,
  phoneDigits,
} from '@/common/utils/admin-identity.util'

import type { AuthenticatedUser } from '@/common/decorators/user.decorator'
import type { AdminUser } from 'generated/prisma/client'

/**
 * Gate for the admin console. Validates the Supabase JWT, then authorises it
 * against the AdminUser table by the token's verified phone/email — matching
 * an ACTIVE, PRE-PROVISIONED row (admins are never auto-created here). The
 * resolved row is attached as `req.admin` for {@link AdminRolesGuard} and
 * controllers.
 */
@Injectable()
export class AdminAuthGuard extends PassportAuthGuard('jwt') {
  constructor(private readonly prisma: PrismaService) {
    super()
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authed = (await super.canActivate(context)) as boolean
    if (!authed) return false

    const req = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser; admin?: AdminUser }>()
    const { user } = req

    const admin = await this.prisma.adminUser.findFirst({
      where: activeAdminWhere({
        phoneDigits: phoneDigits(user?.phone),
        email: user?.email,
      }),
    })
    if (!admin) {
      throw new ForbiddenException('You are not an authorized admin')
    }

    req.admin = admin
    return true
  }
}
