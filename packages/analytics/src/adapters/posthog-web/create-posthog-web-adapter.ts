import {
  type AnalyticsAdapter,
  type AnalyticsProperties,
  type MaybePromise,
} from '../../types'

export interface PostHogWebClient {
  init?: (
    apiKey: string,
    options?: AnalyticsProperties
  ) => MaybePromise<unknown>
  capture: (
    eventName: string,
    properties?: AnalyticsProperties
  ) => MaybePromise<unknown>
  identify: (
    distinctId: string,
    userProperties?: AnalyticsProperties
  ) => MaybePromise<unknown>
  reset?: (resetDeviceId?: boolean) => MaybePromise<unknown>
}

export interface CreatePostHogWebAdapterOptions {
  client: PostHogWebClient
  apiKey?: string
  initOptions?: AnalyticsProperties
  pageEventName?: string
}

const DEFAULT_PAGE_EVENT_NAME = '$pageview'

export const createPostHogWebAdapter = (
  options: CreatePostHogWebAdapterOptions
): AnalyticsAdapter => {
  const pageEventName = options.pageEventName ?? DEFAULT_PAGE_EVENT_NAME

  return {
    name: 'posthog-web',
    init: async (): Promise<void> => {
      if (!options.apiKey || !options.client.init) {
        return
      }
      await Promise.resolve(
        options.client.init(options.apiKey, options.initOptions)
      )
    },
    identify: async ({ userId, traits }): Promise<void> => {
      await Promise.resolve(options.client.identify(userId, traits))
    },
    track: async ({ eventName, properties, metadata }): Promise<void> => {
      await Promise.resolve(
        options.client.capture(eventName, {
          ...properties,
          $insert_id: metadata.eventId,
        })
      )
    },
    page: async ({ pageName, properties, metadata }): Promise<void> => {
      await Promise.resolve(
        options.client.capture(pageEventName, {
          ...properties,
          $insert_id: metadata.eventId,
          page_name: pageName,
        })
      )
    },
    reset: async (): Promise<void> => {
      if (!options.client.reset) {
        return
      }
      await Promise.resolve(options.client.reset())
    },
  }
}
