/**
 * Money self-check — proves the client's amount handling before a user proves it with money.
 *
 *   npx tsx scripts/verify-money.ts
 *
 * The app deliberately does almost no arithmetic on money: the server sends every amount
 * pre-formatted, precisely so there is one implementation of the rounding rules. What is left
 * on the client is the part the server cannot do, and each piece of it is a real way a payment
 * screen goes silently wrong:
 *
 *   1. **The keypad.** Digits are MAJOR units, so `5` `0` `0` is ₹500 — the way every Indian UPI
 *      app behaves, and the correction of a model that read the same keypresses as ₹5.00. The
 *      decimal is entered explicitly, and a leading zero, a bare separator, a backspace to empty
 *      and a 9-digit ceiling are all states the UI can reach.
 *   2. **Indian digit grouping.** 2,2,3 from the right. A user reading a Western-grouped figure
 *      has to count digits to tell a lakh from a million, on the screen where they confirm how
 *      much of their money leaves.
 *   3. **Amount in words** — the cheque's own anti-error device and the reason this surface is
 *      modelled on a cheque book. `₹2,50,000` and `₹25,000` differ by one glyph; "two lakh
 *      fifty thousand" and "twenty-five thousand" cannot be confused. It has to use the INDIAN
 *      numbering system or it does not perform the check it exists for.
 *   4. **Limit comparison.** String order puts `"9"` above `"10"`, so a naive compare either
 *      blocks a valid payment or promises one the server will refuse.
 *
 * Nothing here imports an Expo module, so it runs on a laptop with no device attached.
 */
import {
  amountFromMinor,
  amountInWords,
  amountToMinor,
  compareMinor,
  emptyAmount,
  formatEntry,
  formatMinor,
  formatWithSymbol,
  isAmountEmpty,
  minorExceeds,
  popDigit,
  pushDecimal,
  pushDigit,
  subtractMinor,
  type AmountEntry,
} from '../src/features/payments/money';
import { formatCountdown } from '../src/features/payments/meta/format';

let failures = 0;
let checks = 0;

function check(label: string, pass: boolean, detail?: string): void {
  checks += 1;
  if (!pass) failures += 1;
  const mark = pass ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${label}${detail && !pass ? `\n         ${detail}` : ''}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Type a sequence on the keypad, `.` included.
 *
 * A loop rather than `reduce(pushDigit, …)`: `pushDigit` now takes a currency as its third argument,
 * and `Array.reduce` would hand it the index. The old two-parameter signature made that silently
 * typecheck.
 */
function type(keys: string, currency = 'INR'): AmountEntry {
  let entry = emptyAmount;
  for (const key of keys) {
    entry =
      key === '.'
        ? pushDecimal(entry, currency)
        : pushDigit(entry, key, currency);
  }
  return entry;
}

console.log('\nKEYPAD — digits are MAJOR units');
/**
 * The regression this section exists for.
 *
 * The keypad used to fill from the paise up, so typing `500` produced ₹5.00 and the field read
 * `₹005.00`. Every Indian UPI app treats typed digits as whole rupees, so a payer typing `500` means
 * five hundred — the old behaviour was a hundredfold error in the field that decides how much money
 * moves, and it looked entirely plausible on screen.
 */
eq('typing 500 means five hundred rupees', amountToMinor(type('500')), '50000');
eq(
  '…and reads back as 500.00',
  formatMinor(amountToMinor(type('500')), 'INR'),
  '500.00',
);
eq(
  '…and is spoken as five hundred',
  amountInWords(amountToMinor(type('500')), 'INR'),
  'Five hundred rupees only',
);
eq('a single 5 is five rupees, not five paise', amountToMinor(type('5')), '500');

console.log('\nKEYPAD — the decimal is explicit');
eq('500.50 is 50050 minor', amountToMinor(type('500.50')), '50050');
eq(
  '500.5 is 50050 minor — padded, never multiplied',
  amountToMinor(type('500.5')),
  '50050',
);
eq('.50 is fifty paise', amountToMinor(type('.50')), '50');
eq('a bare separator keeps the integer part', amountToMinor(type('500.')), '50000');
eq('the separator stays visible mid-entry', formatEntry(type('500.'), 'INR'), '500.');
eq('a second separator is ignored', formatEntry(type('500..25'), 'INR'), '500.25');
eq(
  'a third decimal digit is dropped, never shifted',
  amountToMinor(type('500.999')),
  '50099',
);

console.log('\nKEYPAD — the field shows what was pressed');
eq('5 shows as 5, not 0.05', formatEntry(type('5'), 'INR'), '5');
eq('500 shows as 500, not 005.00', formatEntry(type('500'), 'INR'), '500');
eq('nothing typed shows nothing', formatEntry(emptyAmount, 'INR'), '');
eq('grouping applies as it is typed', formatEntry(type('1234567'), 'INR'), '12,34,567');

console.log('\nKEYPAD — edges');
eq('nothing typed is empty', isAmountEmpty(emptyAmount), true);
eq('a leading zero is refused', amountToMinor(pushDigit(emptyAmount, '0')), '0');
eq(
  'zero stays empty, not "0 entered"',
  isAmountEmpty(pushDigit(emptyAmount, '0')),
  true,
);
eq('backspace to empty', amountToMinor(popDigit(type('5'))), '0');
eq('backspace on empty is safe', amountToMinor(popDigit(emptyAmount)), '0');
eq('non-digits are ignored', amountToMinor(pushDigit(type('12'), 'x')), '1200');
// Backspace must undo the last keypress exactly, including the separator itself.
eq(
  'backspace walks the fraction first',
  formatEntry(popDigit(type('500.25')), 'INR'),
  '500.2',
);
eq(
  '…then removes the separator',
  formatEntry(popDigit(popDigit(type('500.2'))), 'INR'),
  '500',
);
eq(
  '…then the whole part',
  formatEntry(popDigit(popDigit(popDigit(type('500.2')))), 'INR'),
  '50',
);
check('the whole part is bounded at 9 digits', type('9999999999').whole.length === 9);

console.log('\nKEYPAD — seeding from the server');
eq('a round amount round-trips', amountToMinor(amountFromMinor('250000')), '250000');
eq(
  '…and seeds with no trailing zeros to delete',
  formatEntry(amountFromMinor('250000'), 'INR'),
  '2,500',
);
eq(
  'a part-rupee amount keeps its paise',
  formatEntry(amountFromMinor('250050'), 'INR'),
  '2,500.50',
);
eq('a sub-rupee amount round-trips', amountToMinor(amountFromMinor('50')), '50');

console.log('\nGROUPING');
// The one that matters: ₹12,34,567.89 — not ₹1,234,567.89.
eq('INR groups 2,2,3 from the right', formatMinor('123456789', 'INR'), '12,34,567.89');
eq('one lakh', formatMinor('10000000', 'INR'), '1,00,000.00');
eq('one thousand', formatMinor('100000', 'INR'), '1,000.00');
eq('under a thousand is ungrouped', formatMinor('99999', 'INR'), '999.99');
eq('one crore', formatMinor('1000000000', 'INR'), '1,00,00,000.00');
eq('SGD groups in threes', formatMinor('123456789', 'SGD'), '1,234,567.89');
eq('the symbol is the currency’s own', formatWithSymbol('250000', 'INR'), '₹2,500.00');
eq('…and SGD’s', formatWithSymbol('250000', 'SGD'), 'S$2,500.00');
eq('zero renders fully', formatMinor('0', 'INR'), '0.00');

console.log('\nAMOUNT IN WORDS — the cheque’s check');
eq('whole rupees', amountInWords('250000', 'INR'), 'Two thousand five hundred rupees only');
eq(
  'rupees and paise',
  amountInWords('12050', 'INR'),
  'One hundred twenty rupees and fifty paise only',
);
eq('one rupee is singular', amountInWords('100', 'INR'), 'One rupee only');
eq('one paisa is singular', amountInWords('1', 'INR'), 'One paisa only');
eq('paise alone, no "zero rupees"', amountInWords('50', 'INR'), 'Fifty paise only');
eq('zero', amountInWords('0', 'INR'), 'Zero rupees only');

// THE distinction the device exists for. Indian numbering, or it does not do its job.
eq('a lakh is a lakh', amountInWords('25000000', 'INR'), 'Two lakh fifty thousand rupees only');
eq(
  'and is not "two hundred fifty thousand"',
  amountInWords('25000000', 'INR').includes('hundred thousand'),
  false,
);
eq('a crore', amountInWords('100000000000', 'INR'), 'One hundred crore rupees only');
// 1234567890 paise is ₹1,23,45,678.90 — the words and the 2,2,3 grouping describe the same
// structure, which is exactly why the two are checked against each other here.
eq('the grouping agrees', formatMinor('1234567890', 'INR'), '1,23,45,678.90');
eq(
  'lakh and crore together',
  amountInWords('1234567890', 'INR'),
  'One crore twenty-three lakh forty-five thousand six hundred seventy-eight rupees and ninety paise only',
);
eq('teens are not tens', amountInWords('1500', 'INR'), 'Fifteen rupees only');
eq('hyphenated tens', amountInWords('4200', 'INR'), 'Forty-two rupees only');

// The pair of figures a mistyped zero produces. If these two strings were confusable the
// device would be pointless.
const small = amountInWords('2500000', 'INR');
const big = amountInWords('25000000', 'INR');
eq('₹25,000', small, 'Twenty-five thousand rupees only');
eq('₹2,50,000', big, 'Two lakh fifty thousand rupees only');
check('an extra zero changes the WORDS, not just a glyph', small !== big);

eq('SGD uses the short scale', amountInWords('250000000', 'SGD'), 'Two million five hundred thousand dollars only');
eq('SGD cents', amountInWords('12050', 'SGD'), 'One hundred twenty dollars and fifty cents only');
eq('one dollar', amountInWords('100', 'SGD'), 'One dollar only');

console.log('\nLIMITS');
// String comparison would order "9" above "10". This is the check that stops a valid payment
// being blocked, or an over-limit one being promised.
eq('numeric order, not lexical', compareMinor('9', '10'), -1);
eq('equal', compareMinor('1000', '1000'), 0);
eq('greater', compareMinor('10001', '10000'), 1);
eq('over the cap', minorExceeds('10000001', '10000000'), true);
eq('exactly the cap is allowed', minorExceeds('10000000', '10000000'), false);
eq('remaining after this payment', subtractMinor('10000000', '2500000'), '7500000');
eq('never negative', subtractMinor('100', '500'), '0');
check(
  'works past 2^53 (a float would round here)',
  compareMinor('9007199254740993', '9007199254740992') === 1,
);

// ── countdown and reset formatting ──────────────────────────────────────────
/**
 * Added after a real defect: `formatCountdown` was written for a 90-second quote lock and reused for
 * a 24-hour limit reset, which rendered a midnight reset as "resets in 1232m 40s" on the Pay tab's
 * own plate. The hours branch is what fixes it, and these cases are what stop it regressing.
 */
{
  check('countdown: seconds only under a minute', formatCountdown(45_000) === '45s');
  check('countdown: minutes and seconds under an hour', formatCountdown(90_000) === '1m 30s');
  check('countdown: quote lock reads in seconds', formatCountdown(89_000) === '1m 29s');
  check(
    'countdown: a 20-hour span reads in HOURS, not 1200 minutes',
    formatCountdown(20.55 * 3600 * 1000) === '20h 33m',
  );
  check('countdown: exactly one hour', formatCountdown(3_600_000) === '1h 00m');
  check('countdown: never negative', formatCountdown(-5_000) === '0s');
}

console.log(`\n${'═'.repeat(58)}`);
console.log(
  failures === 0
    ? `ALL ${checks} CHECKS PASSED — amounts, grouping and the words check out.`
    : `${failures} of ${checks} CHECK(S) FAILED.`,
);
console.log('═'.repeat(58));
process.exit(failures > 0 ? 1 : 0);
