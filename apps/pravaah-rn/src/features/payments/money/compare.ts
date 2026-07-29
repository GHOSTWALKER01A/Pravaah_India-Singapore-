/**
 * Comparing minor-unit amounts.
 *
 * Every function here routes through `BigInt` rather than comparing strings or numbers, and both
 * alternatives are wrong in ways that are easy to ship:
 *
 *  - **String comparison** orders `"9"` above `"10"`, so a ₹0.09 amount would read as exceeding a
 *    ₹0.10 limit.
 *  - **`Number`** silently rounds past 2^53, which a paise figure can reach.
 *
 * These feed limit checks, so getting the order wrong means either blocking a valid payment or
 * promising one the server will refuse at the last step.
 */

export function compareMinor(a: string, b: string): -1 | 0 | 1 {
  const left = BigInt(a.replace(/[^0-9]/g, '') || '0');
  const right = BigInt(b.replace(/[^0-9]/g, '') || '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function minorExceeds(amount: string, ceiling: string): boolean {
  return compareMinor(amount, ceiling) === 1;
}

/** `a - b`, floored at zero. For "how much of the limit is left after this". */
export function subtractMinor(a: string, b: string): string {
  const left = BigInt(a.replace(/[^0-9]/g, '') || '0');
  const right = BigInt(b.replace(/[^0-9]/g, '') || '0');
  return (left > right ? left - right : 0n).toString();
}
