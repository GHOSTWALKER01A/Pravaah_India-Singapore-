import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { SupabaseAuthProvider, SupabaseProvider } from '@/modules/database/supabase/supabase.provider'

@Module({
  imports: [ConfigModule],
  providers: [SupabaseProvider, SupabaseAuthProvider],
  exports: [SupabaseProvider, SupabaseAuthProvider],
})
export class SupabaseModule {}
