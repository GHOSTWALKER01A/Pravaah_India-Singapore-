/**
 * M4 payments wire types.
 *
 * Split by resource because the single file this replaced had grown to 538 lines covering nine
 * unrelated concerns, and the vocabulary at the top of it duplicated `@pravaah/schema` outright.
 *
 * Two rules govern every file behind this barrel, and both come from the backend's own invariants:
 *
 * 1. **Every amount is a `MoneyView`, never a number.** The server sends minor units as a decimal
 *    STRING because `JSON.parse` turns any numeric literal into a float before a line of our code
 *    runs. Nothing in this app does arithmetic on a money field; it formats what it was given.
 * 2. **A status is a union, not a string.** The saga has fourteen states and four of them mean "we
 *    do not know yet" in different ways. A `string` would let a screen render DEEMED as a generic
 *    failure, which is the one reading the backend refuses.
 *
 * The vocabulary itself lives in `vocabulary.ts`, re-exported by `import type` from the shared
 * package — see that file for why it must never become a value import.
 */

export type * from './vocabulary';
export type * from './wallet.schema';
export type * from './transfer.schema';
export type * from './beneficiary.schema';
export type * from './collect.schema';
export type * from './qr.schema';
export type * from './mandate.schema';
export type * from './dispute.schema';
