/**
 * The M4 vocabulary, re-exported from the shared schema package.
 *
 * Every name below was previously re-typed by hand in this app, and again in the admin console —
 * three copies of a fourteen-value status union whose real authority is a Prisma enum. The shared
 * package's own header states the intent that was being ignored: *"so the RN app, the admin
 * console, and the backend validate against one source of truth."* This file is that.
 *
 * **`import type`, deliberately, and it must stay that way.** The imports below are erased at
 * compile time, so Metro never resolves `@pravaah/schema`, no Zod reaches the bundle, and nothing
 * about the app's fragile pinned install changes. `metro.config.js` says in as many words that this
 * app imports nothing from `packages/` — that remains true of the *bundle*, which is the claim that
 * matters. A value import here (a Zod schema object, a `LEDGER_LEG` constant) would break that: it
 * would need `packages/pravaah-schema` added to `watchFolders`, pull Zod into the bundle, and put
 * the single-React guarantee at risk for no gain, because this app validates with TypeScript rather
 * than at runtime.
 *
 * The package suffixes its inferred types `*Input` because they describe request payloads on the
 * backend. In this app they are the vocabulary of both directions, so the local aliases drop the
 * suffix — `TxnStatus`, not `TxnStatusInput`. Renaming at the boundary keeps every call site
 * reading naturally while the authority stays upstream.
 */

import type {
  BeneficiaryHandleTypeInput,
  BeneficiaryStatusInput,
  CollectStatusInput,
  CorridorInput,
  DisputeKindInput,
  DisputeStatusInput,
  LedgerDirectionInput,
  LedgerLegInput,
  MandateExecutionStatusInput,
  MandateFrequencyInput,
  MandateStatusInput,
  PaymentRailInput,
  PurposeCode as PurposeCodeInput,
  QrKindInput,
  TransferTypeInput,
  TxnDirectionInput,
  TxnStatusInput,
  TxnTypeInput,
  UpiHandleStatusInput,
} from '@pravaah/schema/payments';

export type Corridor = CorridorInput;
export type PaymentRail = PaymentRailInput;
export type TxnType = TxnTypeInput;

/** The types a client may ask for directly. TOPUP and WITHDRAWAL have their own routes. */
export type TransferType = TransferTypeInput;

export type TxnDirection = TxnDirectionInput;

/**
 * The saga's fourteen states.
 *
 * `DEEMED` is the one to read twice: the rail never gave a final answer, so the funds sit in
 * suspense and a human decides. It is NOT a failure, and any screen that styles it as one is
 * telling the user their money is gone when it is not. See `TXN_STATUS` in
 * `features/payments/meta` for the presentation that enforces this.
 */
export type TxnStatus = TxnStatusInput;

export type BeneficiaryStatus = BeneficiaryStatusInput;
export type BeneficiaryHandleType = BeneficiaryHandleTypeInput;
export type CollectStatus = CollectStatusInput;
export type MandateStatus = MandateStatusInput;
export type MandateFrequency = MandateFrequencyInput;
export type MandateExecutionStatus = MandateExecutionStatusInput;
export type DisputeKind = DisputeKindInput;
export type DisputeStatus = DisputeStatusInput;
export type QrKind = QrKindInput;
export type UpiHandleStatus = UpiHandleStatusInput;
export type LedgerDirection = LedgerDirectionInput;

/** Which leg of the saga posted a ledger entry. Shown verbatim on the statement. */
export type LedgerLeg = LedgerLegInput;

/** Purpose codes. The cross-border ones are RBI/FEMA codes and are mandatory on the wire. */
export type PurposeCode = PurposeCodeInput;

/**
 * One amount, in every representation a screen needs.
 *
 * Stays local rather than moving upstream: this is a *response projection* the backend computes,
 * not a request shape, and the package's payments module holds request DTOs and vocabulary only.
 * `minor` is the authoritative integer; `major` and `formatted` are already-computed projections —
 * including Indian 2,2,3 digit grouping, which the client must not try to re-derive.
 *
 * Nothing in this app does arithmetic on a money field. It formats what it was given. Typing any
 * of these as `number` would re-introduce the float hazard the backend spent a module avoiding.
 */
export interface MoneyView {
  /** Integer minor units as a digit string. The value to send back to the server. */
  minor: string;
  /** Major units with full precision, e.g. `"1234.50"`. */
  major: string;
  /** Display form with symbol and locale grouping, e.g. `"₹12,34,567.89"`. */
  formatted: string;
  currency: string;
}

/** `ResponseBuilder.paginatedWithOffset`, after the client unwraps `{ data }`. */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore?: boolean;
}
