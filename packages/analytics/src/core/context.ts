import {
  type AnalyticsContext,
  type AnalyticsDispatchMetadata,
  type AnalyticsProperties,
} from '../types'

export const mergeContext = (
  baseContext: AnalyticsContext,
  nextContext: Partial<AnalyticsContext>,
): AnalyticsContext => {
  return {
    ...baseContext,
    ...nextContext,
  }
}

export const buildContextProperties = (
  context: AnalyticsContext,
): AnalyticsProperties => {
  const properties: AnalyticsProperties = {
    product: context.product,
    app: context.app,
    platform: context.platform,
    env: context.env,
  }

  if (context.userId) {
    properties.user_id = context.userId
  }
  if (context.anonymousId) {
    properties.anonymous_id = context.anonymousId
  }
  if (context.sessionId) {
    properties.session_id = context.sessionId
  }
  if (context.appVersion) {
    properties.app_version = context.appVersion
  }
  if (context.locale) {
    properties.locale = context.locale
  }

  return properties
}

export const createDispatchMetadata = (): AnalyticsDispatchMetadata => {
  return {
    eventId: createEventId(),
    timestampIso: new Date().toISOString(),
  }
}

const createEventId = (): string => {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }

  const randomPart = Math.random().toString(16).slice(2, 10)
  return `${Date.now()}-${randomPart}`
}
