import { meta } from './currency';

/**
 * The amount as the user is typing it.
 *
 * Held as the DIGITS THEY PRESSED rather than a number, which is what makes a half-typed value, a
 * bare decimal point and an empty field all representable. A `number` would collapse `''` and `'0'`
 * and lose the distinction between "nothing entered" and "zero entered" — and the send button has to
 * be disabled for the first and refuse the second with a different message.
 *
 * **The digits are MAJOR units, and that is a correction.**
 *
 * This model used to hold minor units, so the keypad filled from the paise up: typing `5` `0` `0`
 * produced ₹5.00, and the screen read `₹005.00` for what the user believed was five hundred rupees.
 * The justification was that it is "how every ATM and card terminal behaves" — true, and the wrong
 * reference. A card terminal is operated by a merchant entering a total they already know; a UPI app
 * is operated by the payer. Every Indian UPI app (PhonePe, Google Pay, Paytm) and PayNow treat typed
 * digits as whole rupees or dollars with the decimal entered explicitly, so a payer who has used any
 * of them types `500` here expecting five hundred. Producing ₹5.00 is not a preference mismatch, it
 * is a hundredfold error in the one field that decides how much money moves.
 *
 * `fraction` is `null` until the separator is actually pressed. That is what distinguishes `500`
 * (₹500.00) from `500.` (a user mid-entry, who should see the point they just typed), and it is why
 * this is two fields rather than one string with a dot in it.
 */
export interface AmountEntry {
  /** Whole major units as typed, no separators. `''` means nothing typed yet. */
  whole: string;
  /**
   * Sub-unit digits as typed: `''` immediately after the separator, `null` before it.
   *
   * Never longer than the currency's exponent, so `500.999` is unreachable rather than silently
   * rounded — rounding a figure the user typed is the one thing a money field must not do.
   */
  fraction: string | null;
}

export const emptyAmount: AmountEntry = { whole: '', fraction: null };

/** How many sub-unit digits this currency admits. INR and SGD are both 2. */
function exponentOf(currency: string): number {
  return meta(currency).exponent;
}

/**
 * Append a digit.
 *
 * Goes into the fraction once the separator has been pressed, otherwise into the whole part. Digits
 * past the currency's exponent are DROPPED rather than shifting the value along, because shifting
 * would silently change an amount the user has already read back to themselves.
 *
 * The whole part caps at 9 digits — ₹99,99,99,999, well past any corridor with a ₹1,00,000 daily cap,
 * and short enough that the denomination cannot overflow its line.
 */
export function pushDigit(
  entry: AmountEntry,
  digit: string,
  currency = 'INR',
): AmountEntry {
  if (!/^[0-9]$/.test(digit)) return entry;

  if (entry.fraction !== null) {
    if (entry.fraction.length >= exponentOf(currency)) return entry;
    return { ...entry, fraction: entry.fraction + digit };
  }

  // A leading zero would make "0" then "5" read as "05". The first non-zero digit starts the figure;
  // a value below one unit is reached by pressing the separator first (`.` `5` `0` → ₹0.50).
  if (entry.whole === '' && digit === '0') return entry;
  if (entry.whole.length >= 9) return entry;
  return { ...entry, whole: entry.whole + digit };
}

/**
 * Press the decimal separator.
 *
 * Idempotent — a second press is ignored rather than inserting a second point. An empty whole part
 * becomes `0`, so `.` `5` `0` reads as ₹0.50 rather than as a figure with no integer part.
 */
export function pushDecimal(entry: AmountEntry, currency = 'INR'): AmountEntry {
  if (exponentOf(currency) === 0) return entry;
  if (entry.fraction !== null) return entry;
  return { whole: entry.whole === '' ? '0' : entry.whole, fraction: '' };
}

/**
 * Delete backwards, one press at a time.
 *
 * Walks the fraction, then the separator, then the whole part — the reverse of the order things were
 * entered, so backspace undoes exactly the last keypress. Removing the separator once the fraction is
 * empty is what lets somebody who mis-pressed `.` recover in a single tap.
 */
export function popDigit(entry: AmountEntry): AmountEntry {
  if (entry.fraction !== null) {
    if (entry.fraction.length > 0) {
      return { ...entry, fraction: entry.fraction.slice(0, -1) };
    }
    return { ...entry, fraction: null };
  }
  return { ...entry, whole: entry.whole.slice(0, -1) };
}

/**
 * The minor-unit string to send to the server.
 *
 * Pure string arithmetic, deliberately. `parseFloat('4.35') * 100` is `434.99999999999994`, and this
 * is the function whose output becomes the amount actually debited — so the fraction is PADDED to the
 * currency's exponent and concatenated, never multiplied.
 */
export function amountToMinor(entry: AmountEntry, currency = 'INR'): string {
  const exponent = exponentOf(currency);
  const whole = entry.whole.replace(/^0+/, '') || '0';
  const fraction = (entry.fraction ?? '')
    .slice(0, exponent)
    .padEnd(exponent, '0');
  const joined = `${whole}${fraction}`.replace(/^0+/, '');
  return joined === '' ? '0' : joined;
}

export function isAmountEmpty(entry: AmountEntry, currency = 'INR'): boolean {
  return amountToMinor(entry, currency) === '0';
}

/** Seed the keypad from a server-supplied minor amount (editing a quote, paying a QR). */
export function amountFromMinor(minor: string, currency = 'INR'): AmountEntry {
  const exponent = exponentOf(currency);
  const digits = (minor.replace(/[^0-9]/g, '') || '0').padStart(
    exponent + 1,
    '0',
  );

  const whole = digits.slice(0, digits.length - exponent).replace(/^0+/, '');
  const fraction = exponent === 0 ? '' : digits.slice(digits.length - exponent);

  return {
    whole,
    /**
     * A round amount seeds with NO fraction.
     *
     * So a ₹500 quote fills the field as `500`, not `500.00` — and one backspace removes the last
     * rupee rather than a trailing zero the user never typed.
     */
    fraction: fraction === '' || /^0+$/.test(fraction) ? null : fraction,
  };
}

/**
 * What to draw in the field: the digits as typed, grouped, with nothing invented.
 *
 * Separate from `formatMinor` on purpose. `formatMinor` renders a SETTLED amount and always shows the
 * sub-unit, which is right on a receipt and wrong under a cursor — it turned `5` into `₹0.05` and
 * `500` into `₹005.00`, padding a figure the user was still halfway through. This shows exactly what
 * has been pressed and no more: `500` while typing, `500.` the moment the separator is pressed,
 * `500.5` after one more key.
 */
export function formatEntry(entry: AmountEntry, currency = 'INR'): string {
  if (entry.whole === '' && entry.fraction === null) return '';

  const whole = entry.whole === '' ? '0' : entry.whole;
  const grouped = currency === 'INR' ? groupIndian(whole) : groupWestern(whole);

  return entry.fraction === null ? grouped : `${grouped}.${entry.fraction}`;
}

/** INR groups 2,2,3 from the right — `12,34,567`, not `1,234,567`. */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
