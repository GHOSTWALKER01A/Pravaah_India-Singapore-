import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { PrismaService } from '@/modules/database/prisma/prisma.service'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
