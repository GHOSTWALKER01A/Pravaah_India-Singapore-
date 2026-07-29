import { meta } from './currency';

/**
 * The amount in words — the cheque's own anti-error device, and the reason this whole surface is
 * modelled on a cheque book.
 *
 * "₹2,50,000" and "₹25,000" differ by one glyph. "Two lakh fifty thousand rupees" and "Twenty five
 * thousand rupees" cannot be confused by anyone reading them. It is the single most effective error
 * check in the history of paper finance, it catches exactly the mistake a numeric keypad invites,
 * and it costs nothing to render.
 *
 * Everything here works on `bigint`. An amount large enough to matter is an amount a double would
 * round.
 */

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

/** 0–999 in words. The building block both numbering systems share. */
function underThousand(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)]!;
    const ones = ONES[n % 10]!;
    return ones ? `${tens}-${ones}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]!} hundred`;
  const rest = underThousand(n % 100);
  return rest ? `${hundreds} ${rest}` : hundreds;
}

/**
 * The Indian numbering system: thousand, lakh, crore.
 *
 * NOT a cosmetic choice. A cheque drawn in India is written in this system, and a payer checking
 * "two lakh fifty thousand" against a figure of `2,50,000` is performing the comparison the device
 * exists for. Rendering it as "two hundred fifty thousand" would break the check for the reader it
 * is meant to protect.
 */
function indianWords(value: bigint): string {
  if (value === 0n) return 'zero';

  const parts: string[] = [];
  // Groups above the first are two digits each in this system, which is exactly why the digit
  // grouping is 2,2,3 — the words and the commas describe the same structure.
  const scales: [bigint, string][] = [
    [10_000_000n, 'crore'],
    [100_000n, 'lakh'],
    [1_000n, 'thousand'],
  ];

  let rest = value;
  for (const [scale, name] of scales) {
    const count = rest / scale;
    if (count > 0n) {
      // A crore count can itself exceed 999 (arab and beyond); recurse so "one hundred twenty-three
      // crore" reads correctly rather than overflowing `underThousand`.
      const spoken =
        count > 999n ? indianWords(count) : underThousand(Number(count));
      parts.push(`${spoken} ${name}`);
      rest %= scale;
    }
  }
  const tail = underThousand(Number(rest));
  if (tail) parts.push(tail);
  return parts.join(' ');
}

/** The short-scale system, for SGD. thousand, million, billion. */
function westernWords(value: bigint): string {
  if (value === 0n) return 'zero';

  const parts: string[] = [];
  const scales: [bigint, string][] = [
    [1_000_000_000n, 'billion'],
    [1_000_000n, 'million'],
    [1_000n, 'thousand'],
  ];

  let rest = value;
  for (const [scale, name] of scales) {
    const count = rest / scale;
    if (count > 0n) {
      const spoken =
        count > 999n ? westernWords(count) : underThousand(Number(count));
      parts.push(`${spoken} ${name}`);
      rest %= scale;
    }
  }
  const tail = underThousand(Number(rest));
  if (tail) parts.push(tail);
  return parts.join(' ');
}

/**
 * A minor-unit amount as the words a cheque would carry.
 *
 * `"250000"` INR → `"Two lakh fifty thousand rupees only"`.
 * `"12050"` INR  → `"One hundred twenty rupees and fifty paise only"`.
 *
 * The trailing "only" is the real convention and it is functional rather than quaint: it marks the
 * end of the written amount so nothing can be appended to it. Kept here for the same reason it
 * exists on paper.
 */
export function amountInWords(minor: string, currency: string): string {
  const { exponent, unit, unitPlural, subUnit, subUnitPlural } =
    meta(currency);
  const digits = (minor.replace(/[^0-9]/g, '') || '0').padStart(
    exponent + 1,
    '0',
  );
  const whole = BigInt(digits.slice(0, digits.length - exponent) || '0');
  const fraction = Number(digits.slice(digits.length - exponent) || '0');

  const speak = currency === 'INR' ? indianWords : westernWords;

  const wholeWords =
    whole === 1n ? `one ${unit}` : `${speak(whole)} ${unitPlural}`;

  if (fraction === 0) {
    return sentence(`${wholeWords} only`);
  }

  const fractionWords = `${underThousand(fraction)} ${
    fraction === 1 ? subUnit : subUnitPlural
  }`;

  // Zero rupees and some paise is a legitimate amount and must not read "zero rupees and…".
  if (whole === 0n) return sentence(`${fractionWords} only`);
  return sentence(`${wholeWords} and ${fractionWords} only`);
}

/** Capitalise the first letter and nothing else, as a cheque's amount line is written. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
