import { defineEventCatalog } from '../core'
import { type AnalyticsEventCatalogBase } from '../types'

export interface CommonAnalyticsEventCatalog extends AnalyticsEventCatalogBase {
  app_launched: {
    launch_source?: string
  }
  page_viewed: {
    page_name: string
    route?: string
    url?: string
  }
  cta_clicked: {
    cta_name: string
    location?: string
  }
  user_identified: {
    method: string
  }
}

export const COMMON_EVENT_CATALOG = defineEventCatalog<CommonAnalyticsEventCatalog>({
  app_launched: {},
  page_viewed: {
    requiredProperties: ['page_name'],
  },
  cta_clicked: {
    requiredProperties: ['cta_name'],
  },
  user_identified: {
    requiredProperties: ['method'],
  },
})
