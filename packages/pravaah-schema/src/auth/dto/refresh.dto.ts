import { z } from 'zod'

import { APIResponseSchema } from '../../common'

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().trim().min(1, 'refreshToken is required'),
})
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>

export const RefreshTokenDataSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
})
export type RefreshTokenData = z.infer<typeof RefreshTokenDataSchema>

export const RefreshTokenResponseSchema = APIResponseSchema(
  RefreshTokenDataSchema,
)
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>
