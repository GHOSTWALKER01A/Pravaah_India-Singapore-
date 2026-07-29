'use client';

import { useQuery } from '@tanstack/react-query';

import type { NavSignalValues } from '@/features/nav';
import { fraudAdminService } from '@/lib/api/fraud/fraud.service';
import { insuranceAdminService } from '@/lib/api/insurance/insurance.service';
import { kycService } from '@/lib/api/kyc/kyc.service';
import { paymentsAdminService } from '@/lib/api/payments/payments.service';

/**
 * The live counts the drawer badges.
 *
 * Both queries reuse the EXACT keys the pages already declare — `['payment-stats']` and
 * `['kyc-cases', 'OPEN']` — which is doing real work rather than being tidy: every
 * mutation in the console already invalidates those keys, so resolving a dispute or
 * deciding a KYC case updates the sidebar badge with no extra plumbing, and opening the
 * page the badge points at costs no additional request because the cache is shared.
 *
 * Failures are swallowed on purpose. A count is an enhancement; a navigation that
 * disappears because a stats endpoint is down is a broken console.
 */
export function useNavSignals(): NavSignalValues {
  const payments = useQuery({
    queryKey: ['payment-stats'],
    queryFn: () => paymentsAdminService.stats(),
    // Matches the interval the payments pages use, so the two observers agree.
    refetchInterval: 60_000,
    retry: 1,
  });

  const kyc = useQuery({
    queryKey: ['kyc-cases', 'OPEN'],
    queryFn: () => kycService.listCases('OPEN'),
    staleTime: 60_000,
    retry: 1,
  });

  // Reuses `['insurance-stats']` — the exact key the M5 pages declare — so deciding a claim
  // invalidates the sidebar badge with no extra plumbing, and opening the page the badge
  // points at costs no additional request.
  const insurance = useQuery({
    queryKey: ['insurance-stats'],
    queryFn: () => insuranceAdminService.stats(),
    refetchInterval: 60_000,
    retry: 1,
  });

  /**
   * Reuses `['fraud-stats']` — the key the M6 pages declare — so resolving a case updates the
   * sidebar badge with no extra plumbing.
   *
   * A 30-second interval rather than the 60 the others use, and that difference is
   * deliberate: this is the only badge in the console attached to a clock. An SLA breach that
   * appears a minute late is a minute of a held customer nobody was told about.
   */
  const fraud = useQuery({
    queryKey: ['fraud-stats'],
    queryFn: () => fraudAdminService.stats(),
    refetchInterval: 30_000,
    retry: 1,
  });

  return {
    kycOpen: kyc.data?.length,
    paymentsNeedAttention: payments.data?.needsAttention,
    openMismatches: payments.data?.openMismatches,
    openDisputes: payments.data?.openDisputes,
    claimsAwaitingReview: insurance.data?.attention.claimsAwaitingReview,
    unpaidClaims: insurance.data?.attention.pendingPayouts,
    openFraudCases: fraud.data?.cases.open,
    fraudSlaBreached: fraud.data?.cases.slaBreached,
  };
}

/**
 * Whether the ledger's trial balance is currently broken.
 *
 * Kept separate from the counts because it is not a queue length — it is the one boolean
 * in the product that means the books do not add up, and it earns its own treatment on
 * the Money group rather than a number nobody can act on directly.
 *
 * `undefined` while loading or on error, so the caller can tell "balanced" from
 * "unknown" and never paints a reassuring state it has not verified.
 */
export function useTrialBalanceOk(): boolean | undefined {
  const { data } = useQuery({
    queryKey: ['payment-stats'],
    queryFn: () => paymentsAdminService.stats(),
    refetchInterval: 60_000,
    retry: 1,
  });
  return data?.trialBalanceOk;
}
