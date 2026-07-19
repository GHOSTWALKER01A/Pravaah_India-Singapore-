import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import duration from 'dayjs/plugin/duration.js'
import isBetween from 'dayjs/plugin/isBetween.js'
import isToday from 'dayjs/plugin/isToday.js'
import localizedFormat from 'dayjs/plugin/localizedFormat.js'
import minmax from 'dayjs/plugin/minMax.js'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import timeZone from 'dayjs/plugin/timezone.js'
import toArray from 'dayjs/plugin/toArray.js'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(customParseFormat)
dayjs.extend(isBetween)
dayjs.extend(isToday)
dayjs.extend(localizedFormat)
dayjs.extend(relativeTime)
dayjs.extend(timeZone)
dayjs.extend(toArray)
dayjs.extend(utc)
dayjs.extend(minmax)
dayjs.extend(duration)

import type customParseFormatPlugin from 'dayjs/plugin/customParseFormat.js'
import type durationPlugin from 'dayjs/plugin/duration.js'
import type isBetweenPlugin from 'dayjs/plugin/isBetween.js'
import type isTodayPlugin from 'dayjs/plugin/isToday.js'
import type localizedFormatPlugin from 'dayjs/plugin/localizedFormat.js'
import type minMaxPlugin from 'dayjs/plugin/minMax.js'
import type relativeTimePlugin from 'dayjs/plugin/relativeTime.js'
import type timezonePlugin from 'dayjs/plugin/timezone.js'
import type toArrayPlugin from 'dayjs/plugin/toArray.js'
import type utcPlugin from 'dayjs/plugin/utc.js'

export type DayjsPlugins = [
  typeof customParseFormatPlugin,
  typeof durationPlugin,
  typeof isBetweenPlugin,
  typeof isTodayPlugin,
  typeof localizedFormatPlugin,
  typeof minMaxPlugin,
  typeof relativeTimePlugin,
  typeof timezonePlugin,
  typeof toArrayPlugin,
  typeof utcPlugin,
]

export type Dayjs = dayjs.Dayjs

export type { ConfigType } from 'dayjs'

export default dayjs
