export type ProductName = 'pravaah' | (string & {})

export type PlatformName = 'web' | 'mobile' | 'backend' | (string & {})

export type EnvironmentName =
  | 'development'
  | 'staging'
  | 'production'
  | 'test'
  | (string & {})

export type MaybePromise<T> = T | Promise<T>

export type AnalyticsProperties = Record<string, unknown>

export type AnalyticsEventCatalogBase = Record<
  string,
  AnalyticsProperties | undefined
>

export interface AnalyticsContext {
  product: ProductName
  app: string
  platform: PlatformName
  env: EnvironmentName
  userId?: string
  anonymousId?: string
  sessionId?: string
  appVersion?: string
  locale?: string
}

export interface AnalyticsEventDefinition<
  Props extends AnalyticsProperties | undefined,
> {
  requiredProperties?: ReadonlyArray<
    Props extends AnalyticsProperties ? Extract<keyof Props, string> : never
  >
}

export type AnalyticsEventCatalogDefinition<C extends AnalyticsEventCatalogBase> = {
  [EventName in keyof C]: AnalyticsEventDefinition<C[EventName]>
}

export type TrackCallArgs<
  C extends AnalyticsEventCatalogBase,
  EventName extends keyof C,
> = C[EventName] extends undefined
  ? [eventName: EventName]
  : [eventName: EventName, properties: C[EventName]]

export interface AnalyticsDispatchMetadata {
  eventId: string
  timestampIso: string
}

export interface AnalyticsInitPayload {
  context: AnalyticsContext
}

export interface AnalyticsIdentifyPayload {
  userId: string
  traits: AnalyticsProperties
  context: AnalyticsContext
}

export interface AnalyticsTrackPayload {
  eventName: string
  properties: AnalyticsProperties
  context: AnalyticsContext
  metadata: AnalyticsDispatchMetadata
}

export interface AnalyticsPagePayload {
  pageName: string
  properties: AnalyticsProperties
  context: AnalyticsContext
  metadata: AnalyticsDispatchMetadata
}

export interface AnalyticsAdapter {
  name: string
  init?: (payload: AnalyticsInitPayload) => MaybePromise<void>
  identify?: (payload: AnalyticsIdentifyPayload) => MaybePromise<void>
  track?: (payload: AnalyticsTrackPayload) => MaybePromise<void>
  page?: (payload: AnalyticsPagePayload) => MaybePromise<void>
  reset?: () => MaybePromise<void>
}

export interface AnalyticsAdapterErrorContext {
  adapterName: string
  operation: 'init' | 'identify' | 'track' | 'page' | 'reset'
}

export interface CreateAnalyticsClientOptions<C extends AnalyticsEventCatalogBase> {
  catalog: AnalyticsEventCatalogDefinition<C>
  context: AnalyticsContext
  adapters: ReadonlyArray<AnalyticsAdapter>
  globalProperties?: AnalyticsProperties
  failOnAdapterError?: boolean
  onError?: (
    error: unknown,
    context: AnalyticsAdapterErrorContext,
  ) => MaybePromise<void>
}

export interface AnalyticsClient<C extends AnalyticsEventCatalogBase> {
  init: () => Promise<void>
  identify: (
    userId: string,
    traits?: AnalyticsProperties,
    options?: { setAsCurrentUser?: boolean },
  ) => Promise<void>
  track: <EventName extends keyof C>(
    ...args: TrackCallArgs<C, EventName>
  ) => Promise<void>
  page: (pageName: string, properties?: AnalyticsProperties) => Promise<void>
  reset: () => Promise<void>
  setContext: (context: Partial<AnalyticsContext>) => void
  getContext: () => AnalyticsContext
}
