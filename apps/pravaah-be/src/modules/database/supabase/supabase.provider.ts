import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { createClient, SupabaseClient } from '@supabase/supabase-js'

import { ENV } from '@/constants/environment.constants'

export const SUPABASE_CLIENT = 'SUPABASE_CLIENT'
export const SUPABASE_AUTH_CLIENT = 'SUPABASE_AUTH_CLIENT'

/**
 * Service-role client. Bypasses row-level security, so it must never carry a
 * user session. Use it for privileged server-side work (storage uploads,
 * admin reads/writes).
 */
export const SupabaseProvider = {
  provide: SUPABASE_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): SupabaseClient<any, 'public'> => {
    const logger = new Logger('SupabaseProvider')
    logger.log('Supabase client initialization started...')

    const supabaseUrl = configService.get<string>(ENV.SUPABASE.URL)
    // Privileged (RLS-bypassing) key: new `SECRET` key first, then legacy names.
    const supabaseKey =
      configService.get<string>(ENV.SUPABASE.SECRET_KEY) ??
      configService.get<string>(ENV.SUPABASE.SERVICE_ROLE_KEY) ??
      configService.get<string>(ENV.SUPABASE.KEY)

    if (!supabaseUrl || !supabaseKey) {
      logger.error('Supabase credentials not found in environment variables')
      throw new Error('Supabase credentials not found in environment variables')
    }

    const client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      db: { schema: 'public' },
    })

    logger.log('Supabase client initialized successfully!')
    return client
  },
}

/**
 * Anon-key client dedicated to user auth flows (signInWithOtp, verifyOtp,
 * refreshSession). These calls store the user's session in memory on the
 * client, which would make every subsequent request authenticate as that
 * user instead of service_role. Keeping them on a separate client ensures
 * the service-role client above never carries a user session.
 */
export const SupabaseAuthProvider = {
  provide: SUPABASE_AUTH_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): SupabaseClient<any, 'public'> => {
    const logger = new Logger('SupabaseAuthProvider')
    logger.log('Supabase auth client initialization started...')

    const supabaseUrl = configService.get<string>(ENV.SUPABASE.URL)
    // Public (anon) key for user auth flows: new `PUBLISHABLE` key, then legacy.
    const supabaseKey =
      configService.get<string>(ENV.SUPABASE.PUBLISHABLE_KEY) ??
      configService.get<string>(ENV.SUPABASE.KEY)

    if (!supabaseUrl || !supabaseKey) {
      logger.error(
        'Supabase auth credentials not found in environment variables',
      )
      throw new Error(
        'Supabase auth credentials not found in environment variables',
      )
    }

    const client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      db: { schema: 'public' },
    })

    logger.log('Supabase auth client initialized successfully!')
    return client
  },
}
