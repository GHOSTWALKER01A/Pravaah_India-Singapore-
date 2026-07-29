import { z } from 'zod'

/**
 * Fine-grained reviewer role. Mirrors the Prisma `AdminRole` enum.
 *
 * Kept in lockstep with `schema.prisma` BY HAND, and the coupling bites: adding
 * `ANALYST` to the database enum without adding it here made `AdminUser.role`
 * unassignable to `AdminProfile.role`, and the console would have rejected every
 * analyst's own profile response. Both lists must change together.
 */
export const ADMIN_ROLE = {
  REVIEWER: 'REVIEWER',
  SENIOR_REVIEWER: 'SENIOR_REVIEWER',
  /** M6 fraud analyst. May work any fraud case; may not confirm a sanctions one. */
  ANALYST: 'ANALYST',
  ADMIN: 'ADMIN',
} as const

export const AdminRoleSchema = z.enum([
  ADMIN_ROLE.REVIEWER,
  ADMIN_ROLE.SENIOR_REVIEWER,
  ADMIN_ROLE.ANALYST,
  ADMIN_ROLE.ADMIN,
])
export type AdminRoleValue = z.infer<typeof AdminRoleSchema>

export const AdminProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  phone: z.string().nullable(),
  role: AdminRoleSchema,
  isActive: z.boolean(),
})
export type AdminProfile = z.infer<typeof AdminProfileSchema>
