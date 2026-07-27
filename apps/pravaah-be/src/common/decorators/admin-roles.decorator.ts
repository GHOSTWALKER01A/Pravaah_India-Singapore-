import { SetMetadata } from '@nestjs/common'

import type { AdminRole } from 'generated/prisma/client'

export const ADMIN_ROLES_KEY = 'admin_roles'

/** Restrict an admin route to the given fine-grained reviewer roles. */
export const AdminRoles = (...roles: AdminRole[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles)
