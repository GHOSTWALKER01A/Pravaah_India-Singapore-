
/** Admin-console roles, mirroring the backend AdminRole enum. */
export const ADMIN_ROLES = ['ADMIN', 'REVIEWER', 'SENIOR_REVIEWER'] as const

export interface SessionClaims {
  sub?: string
  user_role?: string
  role?: string
  app_metadata?: { role?: string }
  exp?: number
}


export function resolveRole(
  claims: SessionClaims | null | undefined,
): string | undefined {
  return claims?.user_role ?? claims?.app_metadata?.role ?? claims?.role
}

export function isAdmin(claims: SessionClaims | null | undefined): boolean {
  const role = resolveRole(claims)
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role)
}
