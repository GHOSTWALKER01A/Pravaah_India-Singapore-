import { AnalyticsValidationError } from '../errors'
import {
  type AnalyticsAdapter,
  type AnalyticsAdapterErrorContext,
  type AnalyticsClient,
  type AnalyticsContext,
  type AnalyticsEventCatalogBase,
  type AnalyticsEventCatalogDefinition,
  type AnalyticsProperties,
  type CreateAnalyticsClientOptions,
  type TrackCallArgs,
} from '../types'
import { buildContextProperties, createDispatchMetadata, mergeContext } from './context'

const toProperties = (input: unknown): AnalyticsProperties => {
  if (input === undefined) {
    return {}
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AnalyticsValidationError(
      'Analytics properties must be an object when provided.',
    )
  }
  return { ...(input as Record<string, unknown>) }
}

const assertEventIsKnown = <C extends AnalyticsEventCatalogBase>(
  catalog: AnalyticsEventCatalogDefinition<C>,
  eventName: string,
): void => {
  if (!Object.prototype.hasOwnProperty.call(catalog, eventName)) {
    throw new AnalyticsValidationError(
      `Unknown analytics event "${eventName}". Add it to the event catalog first.`,
    )
  }
}

const validateRequiredProperties = (
  eventName: string,
  requiredProperties: ReadonlyArray<string>,
  properties: AnalyticsProperties,
): void => {
  for (const propertyName of requiredProperties) {
    if (!(propertyName in properties) || properties[propertyName] == null) {
      throw new AnalyticsValidationError(
        `Missing required analytics property "${propertyName}" for event "${eventName}".`,
      )
    }
  }
}

const buildTrackPayloadProperties = (
  context: AnalyticsContext,
  metadata: { eventId: string; timestampIso: string },
  globalProperties: AnalyticsProperties,
  eventProperties: AnalyticsProperties,
): AnalyticsProperties => {
  return {
    ...globalProperties,
    ...eventProperties,
    ...buildContextProperties(context),
    analytics_event_id: metadata.eventId,
    analytics_timestamp: metadata.timestampIso,
  }
}

export const createAnalyticsClient = <C extends AnalyticsEventCatalogBase>(
  options: CreateAnalyticsClientOptions<C>,
): AnalyticsClient<C> => {
  let currentContext: AnalyticsContext = { ...options.context }
  const adapters: ReadonlyArray<AnalyticsAdapter> = [...options.adapters]
  const globalProperties: AnalyticsProperties = {
    ...(options.globalProperties ?? {}),
  }
  const failOnAdapterError: boolean = options.failOnAdapterError ?? false

  const handleAdapterError = async (
    error: unknown,
    context: AnalyticsAdapterErrorContext,
  ): Promise<void> => {
    if (options.onError) {
      await Promise.resolve(options.onError(error, context))
    }
    if (failOnAdapterError) {
      throw error
    }
  }

  const runForEachAdapter = async (
    operation: AnalyticsAdapterErrorContext['operation'],
    runner: (adapter: AnalyticsAdapter) => Promise<void>,
  ): Promise<void> => {
    for (const adapter of adapters) {
      try {
        await runner(adapter)
      } catch (error: unknown) {
        await handleAdapterError(error, {
          adapterName: adapter.name,
          operation,
        })
      }
    }
  }

  const init = async (): Promise<void> => {
    await runForEachAdapter('init', async (adapter: AnalyticsAdapter) => {
      if (!adapter.init) {
        return
      }
      await Promise.resolve(
        adapter.init({
          context: currentContext,
        }),
      )
    })
  }

  const identify = async (
    userId: string,
    traits: AnalyticsProperties = {},
    identifyOptions?: { setAsCurrentUser?: boolean },
  ): Promise<void> => {
    const safeTraits: AnalyticsProperties = toProperties(traits)
    const setAsCurrentUser: boolean = identifyOptions?.setAsCurrentUser ?? true

    if (setAsCurrentUser) {
      currentContext = mergeContext(currentContext, { userId })
    }

    await runForEachAdapter('identify', async (adapter: AnalyticsAdapter) => {
      if (!adapter.identify) {
        return
      }
      await Promise.resolve(
        adapter.identify({
          userId,
          traits: safeTraits,
          context: currentContext,
        }),
      )
    })
  }

  const track = async <EventName extends keyof C>(
    ...args: TrackCallArgs<C, EventName>
  ): Promise<void> => {
    const eventName: string = String(args[0])
    assertEventIsKnown(options.catalog, eventName)

    const definition = options.catalog[args[0]]
    const requiredProperties: ReadonlyArray<string> = [
      ...((definition.requiredProperties as ReadonlyArray<string> | undefined) ??
        []),
    ]

    const rawProperties =
      args.length > 1 ? (args[1] as unknown) : (undefined as unknown)
    const eventProperties: AnalyticsProperties = toProperties(rawProperties)
    validateRequiredProperties(eventName, requiredProperties, eventProperties)

    const metadata = createDispatchMetadata()
    const properties = buildTrackPayloadProperties(
      currentContext,
      metadata,
      globalProperties,
      eventProperties,
    )

    await runForEachAdapter('track', async (adapter: AnalyticsAdapter) => {
      if (!adapter.track) {
        return
      }
      await Promise.resolve(
        adapter.track({
          eventName,
          properties,
          context: currentContext,
          metadata,
        }),
      )
    })
  }

  const page = async (
    pageName: string,
    properties: AnalyticsProperties = {},
  ): Promise<void> => {
    const safePageProperties: AnalyticsProperties = toProperties(properties)
    const metadata = createDispatchMetadata()

    const payloadProperties: AnalyticsProperties = {
      ...globalProperties,
      ...safePageProperties,
      ...buildContextProperties(currentContext),
      analytics_event_id: metadata.eventId,
      analytics_timestamp: metadata.timestampIso,
      page_name: pageName,
    }

    await runForEachAdapter('page', async (adapter: AnalyticsAdapter) => {
      if (!adapter.page) {
        return
      }
      await Promise.resolve(
        adapter.page({
          pageName,
          properties: payloadProperties,
          context: currentContext,
          metadata,
        }),
      )
    })
  }

  const reset = async (): Promise<void> => {
    currentContext = {
      ...currentContext,
      userId: undefined,
      anonymousId: undefined,
      sessionId: undefined,
    }

    await runForEachAdapter('reset', async (adapter: AnalyticsAdapter) => {
      if (!adapter.reset) {
        return
      }
      await Promise.resolve(adapter.reset())
    })
  }

  const setContext = (context: Partial<AnalyticsContext>): void => {
    currentContext = mergeContext(currentContext, context)
  }

  const getContext = (): AnalyticsContext => {
    return { ...currentContext }
  }

  return {
    init,
    identify,
    track,
    page,
    reset,
    setContext,
    getContext,
  }
}
