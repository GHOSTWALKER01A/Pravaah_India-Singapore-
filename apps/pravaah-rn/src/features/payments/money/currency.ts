/**
 * What each supported currency is called, and how finely it divides.
 *
 * The `unit` / `subUnit` names are load-bearing rather than decorative: `words.ts` speaks them
 * aloud, and "fifty paise" versus "fifty cents" is the difference between a cheque a payer can
 * check and one they cannot.
 */

export const CURRENCY_META = {
  INR: {
    exponent: 2,
    symbol: '₹',
    unit: 'rupee',
    unitPlural: 'rupees',
    subUnit: 'paisa',
    subUnitPlural: 'paise',
  },
  SGD: {
    exponent: 2,
    symbol: 'S$',
    unit: 'dollar',
    unitPlural: 'dollars',
    subUnit: 'cent',
    subUnitPlural: 'cents',
  },
} as const;

export type CurrencyCode = keyof typeof CURRENCY_META;

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return code in CURRENCY_META;
}

/**
 * Look up a currency, throwing on an unknown one.
 *
 * Throwing rather than defaulting to INR is deliberate. A silent fallback would render an SGD
 * amount with a ₹ symbol and read it out in rupees — a wrong figure that looks entirely normal.
 * A thrown error is a crash in development and a caught error at a boundary; a wrong currency
 * symbol on a confirmation screen is a payment made under a false impression.
 */
export function meta(currency: string) {
  const entry = CURRENCY_META[currency as CurrencyCode];
  if (!entry) throw new Error(`Unsupported currency: ${currency}`);
  return entry;
}

export function currencySymbol(currency: string): string {
  return meta(currency).symbol;
}
