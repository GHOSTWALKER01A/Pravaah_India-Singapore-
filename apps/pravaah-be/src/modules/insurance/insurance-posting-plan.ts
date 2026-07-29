import type { Posting } from '@/modules/payments/services/ledger.service'

import { LedgerDirection, LedgerLeg } from 'generated/prisma/client'

/**
 * The M5 posting plans — what each insurance money movement does to the ledger.
 *
 * PURE, exactly like M4's `posting-plan.ts`, and for the same reason: "does this
 * flow conserve money?" becomes a unit test over integers rather than something
 * only observable by buying a policy and inspecting the aftermath.
 *
 * Each plan is balanced PER CURRENCY on its own, so any one of them can be posted
 * atomically without a partner. There is no FX here — a policy's premium and its
 * payout are always in the policy's own currency, because insuring somebody in one
 * currency and paying them in another would move a rate risk onto the claimant at
 * the worst possible moment.
 *
 * ## Why premiums go through SUSPENSE
 *
 * A premium is wallet → insurance float, and it would be one balanced pair. It is
 * deliberately two, through suspense, and the reason is that M4's transaction
 * saga is the only state machine that governs money in this codebase. Its legal
 * path from a created transaction to a settled one runs
 * `VALIDATED → RESERVED → SUBMITTED → SUCCESS`, and `RESERVED` MEANS "the funds
 * have left the wallet and are in suspense". A plan that skipped suspense would
 * need either a new edge in M4's state machine or a transaction whose status
 * lied about where the money was — and the second of those is how a reconciler
 * comes to disagree with a ledger.
 *
 * The visible benefit: a crash between the two steps leaves the money in the
 * SAME suspense account M4's admin console already lists, findable by the same
 * query, resumable by `InsuranceLifecycleService`. Nothing about an insurance
 * premium needs its own recovery story.
 */

/** The accounts one insurance movement touches. Resolved once, passed around. */
export interface InsuranceAccounts {
  /** The policyholder's wallet, in the policy's currency. */
  wallet: string
  /** M4's suspense account for that currency — the same one transfers use. */
  suspense: string
  /**
   * The platform's insurance book (`AccountType.INSURANCE_FLOAT`).
   *
   * Premiums credit it, payouts debit it, and its balance IS the underwriting
   * result: positive means premiums have outrun claims. Permitted to go negative,
   * because an underwriting loss must be visible rather than block a claim.
   */
  float: string
}

function entry(
  accountId: string,
  direction: LedgerDirection,
  amountMinor: bigint,
  currency: string,
  leg: LedgerLeg,
  legRef = '',
): Posting {
  return { accountId, direction, amountMinor, currency, leg, legRef }
}

function assertPositive(amountMinor: bigint, what: string): void {
  if (amountMinor <= 0n) {
    throw new Error(`${what}: amount must be positive`)
  }
}

// ── premium in ──────────────────────────────────────────────────────────────
/**
 * RESERVE the premium — take it out of the policyholder's wallet.
 *
 * Identical in shape to M4's `reservePlan` and deliberately posted on the SAME
 * `RESERVE` leg. Reusing the leg is what lets M4's existing suspense reporting,
 * its overdraft guard and its duplicate-posting constraint apply to an insurance
 * premium with no special-casing: a premium reserve and a transfer reserve are
 * the same event, and giving them different leg names would need every one of
 * those mechanisms taught about the difference.
 */
export function premiumReservePlan(
  accounts: Pick<InsuranceAccounts, 'wallet' | 'suspense'>,
  currency: string,
  amountMinor: bigint,
): Posting[] {
  assertPositive(amountMinor, 'premiumReservePlan')
  return [
    entry(
      accounts.wallet,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.RESERVE,
    ),
    entry(
      accounts.suspense,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.RESERVE,
    ),
  ]
}

/**
 * EARN the premium — suspense → the insurance float.
 *
 * The moment cover becomes funded. Posted on its own `PREMIUM` leg rather than
 * reusing `PAYOUT`, so `Σ credits on the PREMIUM leg` is the exact numerator of
 * the loss ratio's denominator — earned premium, read off the ledger, with no
 * application-level sum that could drift from it.
 */
export function premiumEarnPlan(
  accounts: Pick<InsuranceAccounts, 'suspense' | 'float'>,
  currency: string,
  amountMinor: bigint,
): Posting[] {
  assertPositive(amountMinor, 'premiumEarnPlan')
  return [
    entry(
      accounts.suspense,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.PREMIUM,
    ),
    entry(
      accounts.float,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.PREMIUM,
    ),
  ]
}

/**
 * RELEASE a premium reserve — the mirror of {@link premiumReservePlan}.
 *
 * Used when the money left the wallet but the premium could not be earned: the
 * policy was cancelled mid-collection, or the process died after the reserve. A
 * compensation, not a refund — the premium was never earned, so nothing comes
 * back off the float.
 */
export function premiumReleasePlan(
  accounts: Pick<InsuranceAccounts, 'wallet' | 'suspense'>,
  currency: string,
  amountMinor: bigint,
): Posting[] {
  assertPositive(amountMinor, 'premiumReleasePlan')
  return [
    entry(
      accounts.suspense,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.REVERSE,
    ),
    entry(
      accounts.wallet,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.REVERSE,
    ),
  ]
}

// ── claim payout ────────────────────────────────────────────────────────────
/**
 * RESERVE a claim payout — take the money out of the insurance float.
 *
 * The float is debited BEFORE the claimant is credited, which is the same
 * discipline the transfer saga applies to a sender's wallet: the money stops being
 * available to fund a second payout at this instant, so two concurrent
 * adjudications of the same claim cannot both pay.
 *
 * The float may go negative here, and that is intentional. Refusing a payout
 * because the book is thin would be the insurer failing its own policyholder to
 * keep a number tidy; the negative balance is the honest record of an
 * underwriting loss, and the loss-ratio dashboard is where it shows up.
 */
export function claimReservePlan(
  accounts: Pick<InsuranceAccounts, 'float' | 'suspense'>,
  currency: string,
  amountMinor: bigint,
): Posting[] {
  assertPositive(amountMinor, 'claimReservePlan')
  return [
    entry(
      accounts.float,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.RESERVE,
    ),
    entry(
      accounts.suspense,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.RESERVE,
    ),
  ]
}

/**
 * PAY the claim — suspense → the claimant's wallet.
 *
 * Into the WALLET rather than out to a bank rail, and that is a product decision
 * worth stating. The claimant already holds a Pravaah wallet with a verified UPI
 * handle, so crediting it settles instantly and they can withdraw or spend on the
 * spot. Pushing straight to a bank account would add a rail leg that can fail,
 * pend, or be DEEMED — turning a claim that has been APPROVED into one the
 * claimant cannot see the money from, which for somebody holding a hospital bill
 * is the difference between the product working and not.
 */
export function claimPayoutPlan(
  accounts: Pick<InsuranceAccounts, 'suspense' | 'wallet'>,
  currency: string,
  amountMinor: bigint,
): Posting[] {
  assertPositive(amountMinor, 'claimPayoutPlan')
  return [
    entry(
      accounts.suspense,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.CLAIM_PAYOUT,
    ),
    entry(
      accounts.wallet,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.CLAIM_PAYOUT,
    ),
  ]
}

// ── premium refund (free look) ──────────────────────────────────────────────
/**
 * REFUND an earned premium — the insurance float back to the policyholder.
 *
 * A free-look cancellation, which IRDAI requires a real insurer to honour: the
 * policyholder read the wording, changed their mind inside the window, and gets
 * every rupee back. One balanced pair straight from the float, because the
 * premium was already earned and there is nothing sitting in suspense to unwind.
 *
 * `legRef` carries the PremiumPayment id. That is what lets a policy refunded
 * across two premium periods post two entries instead of colliding on
 * `(transaction, account, direction, leg, legRef)` — the same mechanism M4 uses
 * to make successive partial refunds possible.
 */
export function premiumRefundPlan(
  accounts: Pick<InsuranceAccounts, 'float' | 'wallet'>,
  currency: string,
  amountMinor: bigint,
  legRef: string,
): Posting[] {
  assertPositive(amountMinor, 'premiumRefundPlan')
  if (!legRef) {
    /**
     * Refused rather than defaulted to `''`.
     *
     * An empty legRef would make two refunds on one policy collide on the unique
     * constraint, and the second would surface as a duplicate-posting error that
     * the caller treats as "already refunded" — silently keeping a policyholder's
     * second month of premium.
     */
    throw new Error(
      'premiumRefundPlan: a legRef (the PremiumPayment id) is required so successive refunds cannot collide',
    )
  }
  return [
    entry(
      accounts.float,
      LedgerDirection.DEBIT,
      amountMinor,
      currency,
      LedgerLeg.PREMIUM_REFUND,
      legRef,
    ),
    entry(
      accounts.wallet,
      LedgerDirection.CREDIT,
      amountMinor,
      currency,
      LedgerLeg.PREMIUM_REFUND,
      legRef,
    ),
  ]
}
