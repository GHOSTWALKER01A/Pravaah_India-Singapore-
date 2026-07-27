import { z } from 'zod'

/** Fine-grained reviewer role. Mirrors the Prisma `AdminRole` enum. */
export const ADMIN_ROLE = {
  REVIEWER: 'REVIEWER',
  SENIOR_REVIEWER: 'SENIOR_REVIEWER',
  ADMIN: 'ADMIN',
} as const

export const AdminRoleSchema = z.enum([
  ADMIN_ROLE.REVIEWER,
  ADMIN_ROLE.SENIOR_REVIEWER,
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
