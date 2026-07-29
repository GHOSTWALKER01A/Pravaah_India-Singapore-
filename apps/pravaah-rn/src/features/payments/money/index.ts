/**
 * Client-side money handling. Pure, no I/O, covered by `scripts/verify-money.ts`.
 *
 * The app does almost no arithmetic on money — the server sends every amount pre-formatted as a
 * `MoneyView`, and re-deriving those figures here would be a second implementation of the backend's
 * rounding rules that eventually disagrees with it. What the app genuinely needs and the server
 * cannot provide is only three things, which are the three files behind this barrel:
 *
 * 1. **Keypad → minor units** (`entry.ts`). The user types major units digit by digit; only the
 *    client ever sees that keystroke stream.
 * 2. **Amount in words** (`words.ts`). The cheque's own anti-error device, and the reason this
 *    surface is modelled on a cheque book at all.
 * 3. **Comparison against a limit** (`compare.ts`). Answering "will this be refused?" before the
 *    user commits, rather than after.
 *
 * `format.ts` and `currency.ts` support those. Nothing here uses `parseFloat`: `4.35 * 100` is
 * `434.99999999999994` and a rupee product cannot lose that paisa.
 */

export {
  CURRENCY_META,
  currencySymbol,
  isSupportedCurrency,
  type CurrencyCode,
} from './currency';

export {
  amountFromMinor,
  amountToMinor,
  emptyAmount,
  formatEntry,
  isAmountEmpty,
  popDigit,
  pushDecimal,
  pushDigit,
  type AmountEntry,
} from './entry';

export { formatMinor, formatWithSymbol } from './format';

export { amountInWords } from './words';

export { compareMinor, minorExceeds, subtractMinor } from './compare';
