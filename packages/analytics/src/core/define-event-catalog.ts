import {
  type AnalyticsEventCatalogBase,
  type AnalyticsEventCatalogDefinition,
} from '../types'

export const defineEventCatalog = <C extends AnalyticsEventCatalogBase>(
  catalog: AnalyticsEventCatalogDefinition<C>,
): AnalyticsEventCatalogDefinition<C> => {
  return catalog
}
