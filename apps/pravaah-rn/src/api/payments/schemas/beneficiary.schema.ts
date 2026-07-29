import type { BeneficiaryHandleType, BeneficiaryStatus } from './vocabulary';

/** Payees, and the name check that actually stops social-engineering fraud. */

/**
 * The result of resolving an address to a person.
 *
 * `registeredName` is the name the payee's BANK holds. It is the whole point of the call: an
 * attacker controls the address string they give you but not what the bank calls the account behind
 * it, which is why resolving must happen BEFORE the decision it informs rather than being folded
 * into the transfer.
 */
export interface ResolvedPayee {
  vpa: string;
  reachable: boolean;
  registeredName: string | null;
  bankName: string | null;
  reason: string | null;
}

export interface BeneficiaryView {
  id: string;
  displayName: string;
  registeredName: string | null;
  handleType: BeneficiaryHandleType;
  /** Masked. A payee list is one screenshot away from being shared. */
  handle: string;
  country: string;
  currency: string;
  status: BeneficiaryStatus;
  statusReason: string | null;
  isSelf: boolean;
  screened: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  /**
   * The new-payee restriction, when one applies.
   *
   * Present as an object rather than a boolean because the app has to state the actual cap and the
   * actual expiry — "you can send up to ₹5,000 to this payee until 14:20 tomorrow" is actionable;
   * "this payee is restricted" makes a user retry blindly.
   */
  coolingPeriod: {
    until: string;
    capMinor: string;
    reason: string;
  } | null;
}

/**
 * Adding a payee, as a discriminated union rather than a bag of optional fields.
 *
 * The three handle types need genuinely different inputs, and a flat shape with every field
 * optional would let a caller send an IFSC with a PayNow address and only find out at the server.
 * `isSelf` is absent from the PayNow variant on purpose: a cross-border self-transfer is not a
 * thing this product does, and offering the flag would imply it is.
 */
export type AddBeneficiaryRequest =
  | {
      handleType: 'UPI_VPA';
      vpa: string;
      displayName: string;
      isSelf?: boolean;
    }
  | {
      handleType: 'ACCOUNT_IFSC';
      accountNumber: string;
      ifsc: string;
      displayName: string;
      isSelf?: boolean;
    }
  | {
      handleType: 'PAYNOW_UPI';
      vpa: string;
      displayName: string;
      country: string;
    };

/**
 * The answer to "who is at this phone number?".
 *
 * `matches` is a LIST, and that plural carries the design. An Indian mobile has no directory entry —
 * a PSP simply registers `<number>@<its-handle>` — so the server probes candidates and more than one
 * can legitimately answer. An EMPTY list is a normal outcome, not an error: the person may be
 * perfectly reachable at a UPI ID they chose themselves.
 *
 * `railUnavailable` is what makes an empty list actionable. Same empty list, opposite advice: a payee
 * who is genuinely unregistered means "ask them for their UPI ID", while a lookup that could not
 * reach the network means "try again in a moment".
 *
 * `phone` comes back masked. The client already knows what was typed, so the full number travelling
 * back would only put a third party's payable address into another log.
 */
export interface ResolvedMobile {
  phone: string;
  country: 'IN' | 'SG';
  matches: {
    handle: string;
    handleType: BeneficiaryHandleType;
    registeredName: string | null;
    bankName: string | null;
  }[];
  railUnavailable: boolean;
}
