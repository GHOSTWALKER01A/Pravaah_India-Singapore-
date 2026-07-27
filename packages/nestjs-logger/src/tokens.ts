export const LOGGER_OPTIONS = Symbol('LOGGER_OPTIONS')
export const APP_LOGGER = Symbol('APP_LOGGER')
export const REQUEST_CONTEXT = Symbol('REQUEST_CONTEXT')
export const NEST_LOGGER = Symbol('NEST_LOGGER')

const LOGGER_CONTEXT_PREFIX = 'APP_LOGGER_CONTEXT'

export function getLoggerToken(context: string): string {
  return `${LOGGER_CONTEXT_PREFIX}:${context}`
}
