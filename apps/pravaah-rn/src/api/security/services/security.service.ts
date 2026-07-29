import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  HoldView,
  SecurityActivityView,
  StepUpChallenge,
  StepUpPurpose,
  StepUpResult,
} from '../schemas';

/**
 * Step-up challenges and the two transparency views.
 *
 * ## The scoping guarantee, and the client's half of it
 *
 * `request` sends both a `purpose` and a `subjectId`, and `verify` is checked against
 * them server-side. That pairing is not bookkeeping — without it, a code issued for a
 * ₹100 transfer could be redeemed against a ₹100,000 one. The client's obligation is to
 * name the action it actually intends, and to pass the same pair back.
 *
 * ## Why the transparency views are here rather than in a "profile" service
 *
 * They are the user-facing face of the risk engine, and they answer questions only it can
 * answer: why was I challenged, and what of mine is held. Filing them under a profile
 * service would separate them from the challenge flow they explain.
 */
class SecurityService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.SECURITY.BASE);
  }

  /** Ask for a challenge on an action that was told to step up. */
  request(
    purpose: StepUpPurpose,
    subjectId: string,
  ): Promise<StepUpChallenge> {
    return this.post<StepUpChallenge>(API_ENDPOINTS.SECURITY.STEP_UP_REQUEST, {
      purpose,
      subjectId,
    });
  }

  /**
   * Answer a challenge.
   *
   * The generic endpoint. Note that the flows which ACT on a challenge — completing a
   * bind, releasing a held transfer — have their own dedicated calls, because those must
   * assert the purpose they expect at the point of use rather than accepting whatever the
   * challenge happens to be for.
   */
  verify(nonce: string, answer: string): Promise<StepUpResult> {
    return this.post<StepUpResult>(API_ENDPOINTS.SECURITY.STEP_UP_VERIFY, {
      nonce,
      answer,
    });
  }

  /** My recent security decisions, with the plain-language reasons. */
  activity(): Promise<SecurityActivityView[]> {
    return this.get<SecurityActivityView[]>(
      API_ENDPOINTS.SECURITY.ASSESSMENTS,
    );
  }

  /** Anything of mine under review, with a reference and a route to ask about it. */
  holds(): Promise<HoldView[]> {
    return this.get<HoldView[]>(API_ENDPOINTS.SECURITY.HOLDS);
  }
}

export const securityService = new SecurityService();
