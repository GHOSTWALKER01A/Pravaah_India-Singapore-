import type { Prisma } from 'generated/prisma/client'

const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Build a Prisma `where` that matches an ACTIVE AdminUser by email and/or phone.
 * Phone is matched tolerant of the stored format (`+E164` or bare digits), so a
 * seed row `+919000000001` matches a Supabase token phone claim `919000000001`.
 * With no identifier it matches nothing (never every admin).
 */
export function activeAdminWhere(identity: {
  phoneDigits?: string
  email?: string
}): Prisma.AdminUserWhereInput {
  const or: Prisma.AdminUserWhereInput[] = []
  if (identity.email) or.push({ email: identity.email.toLowerCase() })
  if (identity.phoneDigits) {
    or.push({ phone: { in: [identity.phoneDigits, `+${identity.phoneDigits}`] } })
  }
  return {
    isActive: true,
    OR: or.length ? or : [{ id: NO_MATCH_UUID }],
  }
}

/** Digits-only phone (drops `+`, spaces, etc.) for tolerant matching. */
export function phoneDigits(phone?: string | null): string | undefined {
  const digits = phone?.replace(/\D/g, '')
  return digits ? digits : undefined
}
