import { type AnalyticsAdapter, type AnalyticsProperties, type MaybePromise } from '../../types'

export interface PostHogReactNativeClient {
  setup?: (apiKey: string, options?: AnalyticsProperties) => MaybePromise<void>
  capture: (
    eventName: string,
    properties?: AnalyticsProperties,
  ) => MaybePromise<void>
  identify: (
    distinctId: string,
    userProperties?: AnalyticsProperties,
  ) => MaybePromise<void>
  screen?: (
    screenName: string,
    properties?: AnalyticsProperties,
  ) => MaybePromise<void>
  reset?: (resetDeviceId?: boolean) => MaybePromise<void>
}

export interface CreatePostHogReactNativeAdapterOptions {
  client: PostHogReactNativeClient
  apiKey?: string
  setupOptions?: AnalyticsProperties
  pageEventName?: string
  useScreenForPage?: boolean
}

const DEFAULT_PAGE_EVENT_NAME = '$screen'

export const createPostHogReactNativeAdapter = (
  options: CreatePostHogReactNativeAdapterOptions,
): AnalyticsAdapter => {
  const pageEventName = options.pageEventName ?? DEFAULT_PAGE_EVENT_NAME
  const useScreenForPage = options.useScreenForPage ?? true

  return {
    name: 'posthog-react-native',
    init: async (): Promise<void> => {
      if (!options.apiKey || !options.client.setup) {
        return
      }
      await Promise.resolve(options.client.setup(options.apiKey, options.setupOptions))
    },
    identify: async ({ userId, traits }): Promise<void> => {
      await Promise.resolve(options.client.identify(userId, traits))
    },
    track: async ({ eventName, properties }): Promise<void> => {
      await Promise.resolve(options.client.capture(eventName, properties))
    },
    page: async ({ pageName, properties }): Promise<void> => {
      if (useScreenForPage && options.client.screen) {
        await Promise.resolve(options.client.screen(pageName, properties))
        return
      }

      await Promise.resolve(
        options.client.capture(pageEventName, {
          ...properties,
          page_name: pageName,
        }),
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
