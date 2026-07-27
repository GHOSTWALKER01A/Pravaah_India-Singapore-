import { Global, Module } from '@nestjs/common'

import { AuditService } from '@/modules/audit/audit.service'

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
