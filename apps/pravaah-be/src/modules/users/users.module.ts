import { Global, Module } from '@nestjs/common'

import { PravaahIdService } from '@/modules/users/pravaah-id.service'

/**
 * User identity primitives. Global — like AuthCoreModule — because a user's
 * Pravaah ID is needed wherever a user is provisioned or displayed (auth, KYC,
 * consent, scoring), and threading a module import through all four to reach one
 * stateless issuer buys nothing.
 */
@Global()
@Module({
  providers: [PravaahIdService],
  exports: [PravaahIdService],
})
export class UsersModule {}
