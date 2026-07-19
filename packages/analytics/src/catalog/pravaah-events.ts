import { defineEventCatalog } from '../core'
import { type AnalyticsEventCatalogBase } from '../types'

/**
 * Starter catalog of Pravaah product events.
 *
 * Extend this with your own events as the product grows. Each key maps to the
 * required properties enforced at `track()` time.
 */
export const PRAVAAH_ANALYTICS_EVENTS = {
  APP_LAUNCHED: 'app_launched',
  SIGN_UP: 'sign_up',
  USER_ONBOARDED: 'user_onboarded',
  API_REQUEST_STARTED: 'api_request_started',
  API_REQUEST_SUCCESS: 'api_request_success',
  API_REQUEST_FAILED: 'api_request_failed',
} as const

export interface PravaahAnalyticsEventCatalog extends AnalyticsEventCatalogBase {
  app_launched: undefined
  sign_up: {
    userId: string
    isOnboarded: boolean
  }
  user_onboarded: {
    userId: string
  }
  api_request_started: {
    endpoint?: string
    method?: string
    requestId: string
  }
  api_request_success: {
    endpoint?: string
    method?: string
    statusCode: number
    duration: number
    requestId?: string
  }
  api_request_failed: {
    endpoint?: string
    method?: string
    statusCode?: number
    errorMessage: string
    duration: number
    requestId?: string
  }
}

export const PRAVAAH_EVENT_CATALOG =
  defineEventCatalog<PravaahAnalyticsEventCatalog>({
    app_launched: {},
    sign_up: {
      requiredProperties: ['userId', 'isOnboarded'],
    },
    user_onboarded: {
      requiredProperties: ['userId'],
    },
    api_request_started: {
      requiredProperties: ['requestId'],
    },
    api_request_success: {
      requiredProperties: ['statusCode', 'duration'],
    },
    api_request_failed: {
      requiredProperties: ['errorMessage', 'duration'],
    },
  })
