import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { EmailService } from '@/modules/notifications/email.service'
import { PushService } from '@/modules/notifications/push.service'
import { SmsService } from '@/modules/notifications/sms.service'

/**
 * Delivery channels for OTP and notifications (SMS, email, mobile push). Global
 * so any module can inject the channel services. Providers self-disable when
 * their env is absent, so the app boots without any delivery credentials.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [SmsService, EmailService, PushService],
  exports: [SmsService, EmailService, PushService],
})
export class NotificationsModule {}
