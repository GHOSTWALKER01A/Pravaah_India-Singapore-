/**
 * Minor-unit formatting for the console.
 *
 * The backend sends most amounts pre-formatted, but the admin projection carries several as bare
 * `*Minor` strings — a ledger entry's amount, a trial-balance net, a suspense balance. Those need
 * rendering, and rendering them is the only money arithmetic this app does.
 *
 * No `parseFloat`, and no `Number()` on a minor-unit string. `4.35 * 100` is `434.99999999999994`,
 * and the screen where an operator decides whether the ledger balances is the last place a rounding
 * artefact belongs.
 */

const EXPONENT: Record<string, number> = { INR: 2, SGD: 2 };
const SYMBOL: Record<string, string> = { INR: '₹', SGD: 'S$' };

/**
 * Minor units → a grouped major-unit string, signed.
 *
 * Handles a leading `-` because a trial-balance net and an FX position can both legitimately be
 * negative — and a formatter that silently dropped the sign would turn a broken ledger into a
 * balanced-looking one, which is the single worst thing this function could do.
 */
export function formatMinor(minor: string, currency = 'INR'): string {
  const exponent = EXPONENT[currency] ?? 2;
  const negative = minor.trim().startsWith('-');
  const digits = (minor.replace(/[^0-9]/g, '') || '0').padStart(exponent + 1, '0');

  const whole = digits.slice(0, digits.length - exponent) || '0';
  const fraction = digits.slice(digits.length - exponent);
  const grouped = currency === 'INR' ? groupIndian(whole) : groupWestern(whole);

  const body = exponent === 0 ? grouped : `${grouped}.${fraction}`;
  return `${negative ? '−' : ''}${body}`;
}

export function formatMoney(minor: string, currency = 'INR'): string {
  const negative = minor.trim().startsWith('-');
  const body = formatMinor(minor, currency).replace(/^−/, '');
  return `${negative ? '−' : ''}${SYMBOL[currency] ?? `${currency} `}${body}`;
}

/** INR groups 2,2,3 from the right — `₹12,34,567.89`, not `₹1,234,567.89`. */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Whether a minor-unit string is exactly zero. Used by the trial-balance alarm. */
export function isZeroMinor(minor: string): boolean {
  return (minor.replace(/[^0-9]/g, '') || '0').replace(/^0+/, '') === '';
}
