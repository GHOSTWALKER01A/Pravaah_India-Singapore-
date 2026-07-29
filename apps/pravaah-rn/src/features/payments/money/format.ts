import { meta } from './currency';

/**
 * Minor units → a grouped major-unit string.
 *
 * This duplicates the server's `formatMoney` on purpose, and the boundary is exact: the keypad has
 * to render a figure that has not been sent anywhere yet, so the client must be able to format one.
 * Every amount that HAS come from the server is rendered from its own `formatted` field and never
 * re-derived here — two formatters agreeing today is not two formatters agreeing next year.
 *
 * No `parseFloat` anywhere in this file. `4.35 * 100` is `434.99999999999994`, and a rupee product
 * cannot lose that paisa.
 */
export function formatMinor(minor: string, currency: string): string {
  // Widened to `number` deliberately: every supported currency is 2dp today, but the zero-exponent
  // branch below is what a 0dp corridor (JPY, KRW) needs, and narrowing to a literal `2` would make
  // adding one a silent hundredfold error rather than a compile step.
  const exponent: number = meta(currency).exponent;
  const digits = (minor.replace(/[^0-9]/g, '') || '0').padStart(
    exponent + 1,
    '0',
  );
  const whole = digits.slice(0, digits.length - exponent) || '0';
  const fraction = digits.slice(digits.length - exponent);
  const grouped = currency === 'INR' ? groupIndian(whole) : groupWestern(whole);
  return exponent === 0 ? grouped : `${grouped}.${fraction}`;
}

export function formatWithSymbol(minor: string, currency: string): string {
  return `${meta(currency).symbol}${formatMinor(minor, currency)}`;
}

/**
 * INR groups 2,2,3 from the right — `12,34,567.89`, not `1,234,567.89`.
 *
 * An Indian user reading a Western-grouped figure has to count digits to tell a lakh from a
 * million, on the one screen where they confirm how much of their money leaves. The grouping and
 * the words in `words.ts` describe the same structure, which is why both exist.
 */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
