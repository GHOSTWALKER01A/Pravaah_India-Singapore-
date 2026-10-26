import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  type CanActivate,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport'

import type { AuthenticatedUser } from '@/common/decorators/user.decorator'

import type {
  PartnerRole,
  PartnerUser,
  VerifierPartner,
} from 'generated/prisma/client'

import { roleAtLeast } from '@/modules/partner/partner.state'
import { PartnerUserService } from '@/modules/partner/services/partner-user.service'

/** What {@link PartnerConsoleGuard} attaches to the request. */
export interface PartnerConsoleContext {
  user: AuthenticatedUser
  partnerUser: PartnerUser
  consolePartner: VerifierPartner
}

/**
 * Gate for the partner web console.
 *
 * Validates the ordinary session JWT (the same OTP login the app uses), then
 * authorises it against `PartnerUser` by the token's verified phone or email —
 * matching an ACTIVE, PRE-PROVISIONED member of a non-revoked partner. The mirror
 * of `AdminAuthGuard`: no console account is ever created by a login.
 *
 * A PENDING_APPROVAL or SUSPENDED partner's users CAN sign in — to follow their
 * application or read their history. Whether they can DO anything is decided by the
 * services, which refuse verification work for a partner that is not ACTIVE.
 */
@Injectable()
export class PartnerConsoleGuard extends PassportAuthGuard('jwt') {
  constructor(private readonly users: PartnerUserService) {
    super()
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authed = (await super.canActivate(context)) as boolean
    if (!authed) return false

    const req = context
      .switchToHttp()
      .getRequest<
        Partial<PartnerConsoleContext> & { user: AuthenticatedUser }
      >()

    const member = await this.users.resolveForSession({
      phone: req.user?.phone,
      email: req.user?.email,
    })
    if (!member) {
      throw new ForbiddenException(
        'You do not have access to a partner console',
      )
    }

    const { partner, ...partnerUser } = member
    req.partnerUser = partnerUser
    req.consolePartner = partner
    return true
  }
}

export const PARTNER_MIN_ROLE_KEY = 'partner_min_role'

/**
 * The least role a console route needs. Roles are a strict ladder
 * (VIEWER < ANALYST < ADMIN), so a minimum reads truer than a list — adding a role
 * later cannot silently lock admins out of a route that listed only "analyst".
 */
export const PartnerMinRole = (role: PartnerRole) =>
  SetMetadata(PARTNER_MIN_ROLE_KEY, role)

/** RBAC for the console. Runs after {@link PartnerConsoleGuard}. No metadata = any member. */
@Injectable()
export class PartnerRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PartnerRole | undefined>(
      PARTNER_MIN_ROLE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    )
    if (!required) return true

    const { partnerUser } = ctx
      .switchToHttp()
      .getRequest<Partial<PartnerConsoleContext>>()
    if (!partnerUser || !roleAtLeast(partnerUser.role, required)) {
      throw new ForbiddenException(
        'Your console role does not allow this action',
      )
    }
    return true
  }
}
