/**
 * The human meaning of every M4 code, in one place.
 *
 * Each map is a `Record` keyed on a type from `@pravaah/schema`, never a lookup with a fallback. That
 * is the point of the folder: adding a status, a leg, a purpose code or a dispute kind to the backend
 * enum makes this fail to COMPILE rather than silently rendering a raw `SCREAMING_CASE` token at a
 * user who is trying to work out where their money is.
 */

export {
  TXN_STATUS,
  txnStatus,
  type PaymentTone,
  type StatusPresentation,
} from './status';

export { LEDGER_LEG_LABEL } from './ledger';

export {
  CORRIDOR_META,
  CROSS_BORDER_PURPOSES,
  DOMESTIC_PURPOSES,
  PURPOSE_LABEL,
  purposesFor,
  typeForPurpose,
} from './purpose';

export { MANDATE_FREQUENCY } from './mandate';

export { DISPUTE_KIND } from './dispute';

export { formatCountdown, formatRate, formatResetAt } from './format';
