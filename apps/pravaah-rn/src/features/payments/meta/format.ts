/**
 * Two formatters that belong to presentation rather than to money.
 *
 * Kept out of `money/` deliberately: neither touches a minor-unit amount, and putting them there
 * would blur the one rule that folder enforces — that everything in it is integer arithmetic on
 * strings and `bigint`.
 */

/**
 * Countdown formatting, scaled to the magnitude it is given.
 *
 * This function serves two spans that differ by three orders of magnitude: a 90-second quote lock
 * and a 24-hour limit reset. Written for the first and reused for the second, it rendered a
 * midnight reset as **"resets in 1232m 40s"** — a number nobody can read as "tomorrow morning", on
 * the plate where the user is deciding whether they can send a payment today.
 *
 * So the unit follows the span. Seconds are dropped once there are hours, because at that distance a
 * second-precision countdown is false precision that also forces a re-render every tick.
 *
 * Floors at `0s` rather than going negative: a countdown showing `-3s` tells the user the app has
 * lost track of time, when in fact the quote has simply expired and the screen should say so.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * The same span as a plain-English clock time, for a deadline rather than a countdown.
 *
 * A daily limit does not reset "in 20h 32m", it resets at midnight — and that is what a person
 * actually needs to know when they are deciding whether to wait. Used on the leaf, where the reset
 * is a fact about tomorrow; the countdown form is kept for a quote, where the elapsing IS the point.
 */
export function formatResetAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'midnight';

  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  // Midnight is the real reset boundary for a UPI daily cap, and "resets at midnight" reads as a
  // rule where "resets at 00:00" reads as a machine timestamp.
  if (at.getHours() === 0 && at.getMinutes() === 0) return 'midnight';
  return sameDay ? time : `${time} tomorrow`;
}

/**
 * A rate as a customer should read it: "1 SGD = 65.0730 INR".
 *
 * Four decimals, because that is where an exchange rate stops being information and starts being
 * noise — but the FULL rate is still what the server priced against, and the receipt carries it
 * verbatim. Truncating for display is fine; truncating what we charge against would not be.
 */
export function formatRate(
  rate: string,
  sourceCurrency: string,
  destCurrency: string,
): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  const shown = fraction
    ? `${whole}.${fraction.slice(0, 4).padEnd(4, '0')}`
    : whole;
  return `1 ${sourceCurrency} = ${shown} ${destCurrency}`;
}
