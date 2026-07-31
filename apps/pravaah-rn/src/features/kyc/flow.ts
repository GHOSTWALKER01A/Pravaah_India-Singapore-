import { type Href } from 'expo-router';

import type { CheckStatus, CheckType, Country, KycProfileStatus } from '@/api';
import { ROUTES } from '@/constants/routes.constants';

/**
 * Required checks per country — mirrors REQUIRED_CHECKS in the backend
 * kyc.state.ts. Order defines the on-boarding step sequence.
 */
export const REQUIRED_CHECKS: Record<Country, CheckType[]> = {
  INDIA: [
    'PAN',
    'AADHAAR_OKYC',
    'BANK_PENNY_DROP',
    'LIVENESS',
    'FACE_MATCH',
    'SANCTIONS_PEP',
  ],
  SINGAPORE: ['SINGPASS_MYINFO', 'LIVENESS', 'FACE_MATCH', 'SANCTIONS_PEP'],
  BOTH: [
    'PAN',
    'AADHAAR_OKYC',
    'BANK_PENNY_DROP',
    'SINGPASS_MYINFO',
    'LIVENESS',
    'FACE_MATCH',
    'SANCTIONS_PEP',
  ],
};

/** Which screen handles each check. */
export const CHECK_ROUTE: Record<CheckType, Href> = {
  PAN: ROUTES.KYC.INDIA.PAN,
  AADHAAR_OKYC: ROUTES.KYC.INDIA.AADHAAR,
  BANK_PENNY_DROP: ROUTES.KYC.INDIA.BANK,
  SINGPASS_MYINFO: ROUTES.KYC.SINGAPORE,
  LIVENESS: ROUTES.KYC.LIVENESS,
  FACE_MATCH: ROUTES.KYC.FACE_MATCH,
  SANCTIONS_PEP: ROUTES.KYC.SANCTIONS,
};

/** Status of a specific check, if it has been attempted. */
export function checkStatusOf(
  status: KycProfileStatus,
  type: CheckType,
): CheckStatus | undefined {
  return status.checks.find((c) => c.checkType === type)?.status;
}

/**
 * Statuses that let the flow move PAST a step. `PASSED` = verified; the user
 * did what they can on `MANUAL_REVIEW` (it's now under async human review), so
 * we let them continue and the profile settles to IN_REVIEW on the status
 * screen. Everything else — no record yet, `FAILED`, `PENDING`, `EXPIRED` —
 * keeps the user ON that step to finish or retry it.
 */
const CLEARED: ReadonlySet<CheckStatus> = new Set(['PASSED', 'MANUAL_REVIEW']);

/**
 * The next required check the user still has to clear — this drives forward
 * navigation. It is the FIRST required check that is not yet cleared, so the
 * flow never skips ahead of an un-verified step (a failed/pending PAN keeps you
 * on PAN, not Aadhaar). Returns null once every step is cleared → status screen.
 */
export function nextCheck(status: KycProfileStatus): CheckType | null {
  return (
    REQUIRED_CHECKS[status.country].find((t) => {
      const s = checkStatusOf(status, t);
      return !s || !CLEARED.has(s);
    }) ?? null
  );
}

export function nextRoute(status: KycProfileStatus): Href {
  const next = nextCheck(status);
  return next ? CHECK_ROUTE[next] : (ROUTES.KYC.STATUS as Href);
}

/**
 * IN_REVIEW, but with nothing wrong — the profile is waiting only for a reviewer
 * to approve it.
 *
 * One status token covers two situations that need different words. A holder
 * whose documents disagreed is waiting while somebody adjudicates a discrepancy;
 * a holder in this state did everything right and is queued. Telling the second
 * group "a person is checking the details that did not match" invents a problem
 * they do not have.
 *
 * ── Why this reads a server field instead of deriving it ──
 * It is not derivable here, and both plausible derivations are wrong:
 *
 *   - "every required check PASSED" — a name-mismatch review has every check
 *     passed too. That is the one case this must exclude.
 *   - "nameMatchScore >= threshold" — a single-source profile stores 1.0 while
 *     the backend's decision treated the score as unreconciled, so this gets
 *     that case backwards. It would also mirror a policy constant.
 *
 * The server sends its own `machineCleared` verdict from the decision that
 * produced the response, so the words shown here and the reason the reviewer
 * sees cannot disagree. Absent (older API), we fall back to the cautious copy.
 */
export function awaitingApproval(status: KycProfileStatus): boolean {
  return status.overallStatus === 'IN_REVIEW' && status.awaitingApproval === true;
}

/** Progress across the required steps for the current country. */
export function progress(status: KycProfileStatus): {
  done: number;
  total: number;
} {
  const required = REQUIRED_CHECKS[status.country];
  const passed = new Set(
    status.checks.filter((c) => c.status === 'PASSED').map((c) => c.checkType),
  );
  return {
    done: required.filter((t) => passed.has(t)).length,
    total: required.length,
  };
}
