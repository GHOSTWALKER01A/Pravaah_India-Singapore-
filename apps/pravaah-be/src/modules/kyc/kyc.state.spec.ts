import {
  CheckStatus,
  CheckType,
  KycStatus,
  ReviewDecision,
} from 'generated/prisma/client'

import {
  NAME_MATCH_THRESHOLD,
  REQUIRED_CHECKS,
  REVIEW_PENDING_REASON,
  applyReviewDecision,
  evaluateKyc,
  type Evaluation,
} from '@/modules/kyc/kyc.state'

/** Every India check passing, which is the state most of these cases start from. */
function allPassed(): Evaluation['checks'] {
  return REQUIRED_CHECKS.INDIA.map((type) => ({
    type,
    status: CheckStatus.PASSED,
  }))
}

function evaluate(overrides: Partial<Evaluation> = {}) {
  return evaluateKyc({
    requiredForCountry: REQUIRED_CHECKS.INDIA,
    checks: allPassed(),
    nameMatchScore: 0.97,
    sanctionsHit: false,
    threshold: NAME_MATCH_THRESHOLD,
    ...overrides,
  })
}

describe('kyc.state', () => {
  describe('evaluateKyc — the machine verdict', () => {
    it('never returns VERIFIED, even with everything passing', () => {
      // The load-bearing invariant of the whole flow: verification is a human
      // decision. If this function could answer VERIFIED, a profile would go
      // live without anyone approving it.
      const decision = evaluate()
      expect(decision.status).toBe(KycStatus.IN_REVIEW)
      expect(decision.reason).toBe(REVIEW_PENDING_REASON)
      expect(decision.machineCleared).toBe(true)
    })

    it('marks only the clean profile as machine-cleared', () => {
      // The reviewer console shows this reason, and "pending approval" is a
      // different job from "these documents disagree".
      expect(evaluate({ nameMatchScore: 0.4 }).machineCleared).toBeUndefined()
      expect(
        evaluate({
          checks: allPassed().map((c) =>
            c.type === CheckType.FACE_MATCH
              ? { ...c, status: CheckStatus.MANUAL_REVIEW }
              : c,
          ),
        }).machineCleared,
      ).toBeUndefined()
    })

    it('treats a sanctions hit as an unconditional stop', () => {
      expect(evaluate({ sanctionsHit: true }).status).toBe(KycStatus.REJECTED)
    })

    it('reports progress before review while a check is missing or pending', () => {
      expect(evaluate({ checks: [] }).status).toBe(KycStatus.IN_PROGRESS)
      expect(
        evaluate({
          checks: allPassed().map((c) =>
            c.type === CheckType.LIVENESS
              ? { ...c, status: CheckStatus.PENDING }
              : c,
          ),
        }).status,
      ).toBe(KycStatus.IN_PROGRESS)
    })

    it('asks the holder to act on a failed check', () => {
      expect(
        evaluate({
          checks: allPassed().map((c) =>
            c.type === CheckType.PAN ? { ...c, status: CheckStatus.FAILED } : c,
          ),
        }).status,
      ).toBe(KycStatus.ACTION_REQUIRED)
    })

    it('sends an unreconciled name to review', () => {
      expect(evaluate({ nameMatchScore: null }).status).toBe(
        KycStatus.IN_REVIEW,
      )
      expect(evaluate({ nameMatchScore: 0.5 }).status).toBe(KycStatus.IN_REVIEW)
    })
  })

  describe('applyReviewDecision — the human verdict', () => {
    const machine = evaluate()

    it('turns an approval into VERIFIED, repeatably', () => {
      // Repeatably matters more than it looks: status is re-derived on every
      // recorded check AND every status read, so a decision that did not survive
      // re-derivation was undone within seconds of being granted.
      for (let i = 0; i < 3; i++) {
        expect(
          applyReviewDecision(machine, {
            decision: ReviewDecision.APPROVED,
            stale: false,
          }).status,
        ).toBe(KycStatus.VERIFIED)
      }
    })

    it('maps the other two decisions onto their own statuses', () => {
      expect(
        applyReviewDecision(machine, {
          decision: ReviewDecision.REJECTED,
          stale: false,
        }).status,
      ).toBe(KycStatus.REJECTED)
      expect(
        applyReviewDecision(machine, {
          decision: ReviewDecision.INFO_REQUESTED,
          stale: false,
        }).status,
      ).toBe(KycStatus.ACTION_REQUIRED)
    })

    it('leaves the machine verdict alone when nobody has decided', () => {
      expect(applyReviewDecision(machine, null)).toEqual(machine)
      expect(
        applyReviewDecision(machine, { decision: null, stale: false }),
      ).toEqual(machine)
    })

    it('drops machineCleared once a decision is applied', () => {
      // An answered case is not awaiting an answer. `getProfileStatus` derives the
      // client's `awaitingApproval` flag from this, so leaking the flag through an
      // approval would tell a verified holder they are still queued.
      const approved = applyReviewDecision(machine, {
        decision: ReviewDecision.APPROVED,
        stale: false,
      })
      expect(approved.machineCleared).toBeUndefined()
      // Still set while nobody has answered — that IS the awaiting-approval state.
      expect(applyReviewDecision(machine, null).machineCleared).toBe(true)
    })

    it('ignores a decision the checks have moved past', () => {
      // An admin approves the evidence they were looking at. A check recorded
      // afterwards is evidence they never saw, so the profile goes back to them
      // rather than keeping a status granted for the old check set.
      expect(
        applyReviewDecision(machine, {
          decision: ReviewDecision.APPROVED,
          stale: true,
        }).status,
      ).toBe(KycStatus.IN_REVIEW)
    })

    it('keeps the machine veto over an approval on file', () => {
      // An approval is not a standing exemption from the checks themselves: if a
      // required check is now failing, that wins.
      const failing = evaluate({
        checks: allPassed().map((c) =>
          c.type === CheckType.BANK_PENNY_DROP
            ? { ...c, status: CheckStatus.FAILED }
            : c,
        ),
      })
      expect(
        applyReviewDecision(failing, {
          decision: ReviewDecision.APPROVED,
          stale: false,
        }).status,
      ).toBe(KycStatus.ACTION_REQUIRED)

      const sanctioned = evaluate({ sanctionsHit: true })
      expect(
        applyReviewDecision(sanctioned, {
          decision: ReviewDecision.APPROVED,
          stale: false,
        }).status,
      ).toBe(KycStatus.REJECTED)
    })
  })
})
