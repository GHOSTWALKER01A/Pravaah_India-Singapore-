import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_LOGGER, type AppLogger } from '@pravaah/nestjs-logger'
import axios from 'axios'

import { ENV } from '@/constants/environment.constants'

// Expo's public push endpoint. No credentials required; an optional access
// token (EXPO_ACCESS_TOKEN) turns on Expo's enhanced push security.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** An Expo push token always looks like `ExponentPushToken[xxxxxxxx]`. */
export function isExpoPushToken(token: string | null | undefined): token is string {
  return (
    !!token &&
    (token.startsWith('ExponentPushToken[') ||
      token.startsWith('ExpoPushToken[')) &&
    token.endsWith(']')
  )
}

/**
 * Mobile push via the Expo Push API. Mirrors {@link SmsService}: env-driven,
 * self-disabling, and never throws into the caller — a push failure is logged
 * and swallowed. Delivery to a device that has the app closed is handled by
 * Expo (→ FCM/APNs); this service only hands the message to Expo.
 */
@Injectable()
export class PushService {
  private readonly logger: AppLogger

  constructor(
    private readonly config: ConfigService,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ context: PushService.name })
  }

  /** Push is always available (public endpoint); a token is the only requirement. */
  isEnabled(): boolean {
    return true
  }

  async send(input: {
    token: string
    title: string
    body: string
    data?: Record<string, unknown>
  }): Promise<{ sent: boolean }> {
    if (!isExpoPushToken(input.token)) {
      this.logger.warn(`[${this.send.name}] Skipping — not an Expo push token`)
      return { sent: false }
    }

    const accessToken = this.config.get<string>(ENV.EXPO.ACCESS_TOKEN)
    try {
      const res = await axios.post(
        EXPO_PUSH_URL,
        {
          to: input.token,
          title: input.title,
          body: input.body,
          sound: 'default',
          priority: 'high',
          data: input.data ?? {},
        },
        {
          headers: {
            'content-type': 'application/json',
            ...(accessToken && { authorization: `Bearer ${accessToken}` }),
          },
          timeout: 15_000,
        },
      )
      // Expo returns { data: { status: 'ok' | 'error', ... } } per message.
      const status = (res.data as { data?: { status?: string } })?.data?.status
      if (status && status !== 'ok') {
        this.logger.warn(`[${this.send.name}] Expo reported a push error`, {
          status,
          detail: res.data,
        })
        return { sent: false }
      }
      this.logger.info(`[${this.send.name}] Push dispatched`, { status })
      return { sent: true }
    } catch (error) {
      this.logger.error(`[${this.send.name}] Failed to dispatch push`, {
        err: error,
      })
      return { sent: false }
    }
  }
}
