export const ROLES = {
  ADMIN: 'ADMIN',
  USER: 'USER',
} as const

export const MAX_PROFILE_IMAGE_SIZE = 3 * 1024 * 1024 // 3 MB
export const MAX_RESUME_SIZE = 5 * 1024 * 1024 // 5 MB

export const PARAMS = {
  USER_ID: 'userId',
  SERVICE_ID: 'serviceId',
  SLUG: 'slug',
} as const

export const QUERY = {
  SERVICE_ID: 'serviceId',
  SEARCH: 'search',
  STATUS: 'status',
} as const

export const RATE_LIMITER = {
  API_GENERAL: {
    LIMIT: 100,
    TTL_MS: 60_000,
  },
  CONTACT: {
    LIMIT: 2,
    TTL_MS: 60_000,
  },
  AUTH_SEND_OTP: {
    LIMIT: 3,
    TTL_MS: 60_000,
    BLOCK_MS: 300_000,
  },
  AUTH_VERIFY_OTP: {
    LIMIT: 5,
    TTL_MS: 60_000,
    BLOCK_MS: 300_000,
  },
  AUTH_REFRESH_TOKEN: {
    LIMIT: 30,
    TTL_MS: 60_000,
    BLOCK_MS: 60_000,
  },
} as const
