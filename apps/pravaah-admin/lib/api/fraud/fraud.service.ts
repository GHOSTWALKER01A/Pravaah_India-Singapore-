import { API_ENDPOINTS } from '@/features/endpoints';

import { BaseAPIService } from '../core/base-api-service';
import type {
  AddListEntryRequest,
  AdminAssessmentRow,
  AdminRiskAssessment,
  FraudCaseDetail,
  FraudCaseRow,
  FraudCaseStatus,
  FraudSeverity,
  FraudStats,
  GraphNeighbourhood,
  GraphRecomputeResult,
  ListSummaryRow,
  Paged,
  RemoveListEntryRequest,
  ResolveCaseRequest,
  ResolveCaseResult,
  RiskDecision,
  RiskSubjectType,
  UserRiskProfile,
} from './fraud.schema';

/**
 * M6 admin console — the fraud queue, the assessments, the lists, and the graph.
 *
 * ## What this service never sends
 *
 * No `analystId` and no `role`, on any call. Both come from the authenticated admin session
 * server-side, and that is a control rather than a convenience: a body field for either would
 * let any authenticated analyst confirm a sanctions case by typing `"role": "ADMIN"`, and
 * would make every case release unattributable. Clearing a case RELEASES money an automated
 * control had stopped — an unattributable release is the single most useful thing an insider
 * could do.
 *
 * ## Why every write calls the same service the app does
 *
 * There is deliberately no admin-only release path. Clearing a case goes through M6's
 * `RiskActionRegistry`, which calls M4's `resolveRiskHold` — the same method the user's own
 * step-up uses. A second implementation of "let this payment through" would eventually let it
 * through differently, and the ledger and the case must never disagree about what was
 * released. The admin route adds attribution and a required reason on top of the ordinary
 * flow, nothing more.
 */
class FraudAdminService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.FRAUD.BASE);
  }

  /**
   * Build a query string, dropping the console's own sentinels.
   *
   * `'ALL'` is a UI value for "no filter" and must not reach the server, which would reject it
   * as an invalid enum member. Same helper and same reasoning as the insurance service.
   */
  private query(params: Record<string, unknown>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        value === 'ALL' ||
        value === false
      ) {
        continue;
      }
      query.set(key, String(value));
    }
    const rendered = query.toString();
    return rendered ? `?${rendered}` : '';
  }

  // ── overview ──────────────────────────────────────────────────────────────
  stats(): Promise<FraudStats> {
    return this.get<FraudStats>(API_ENDPOINTS.FRAUD.STATS);
  }

  // ── cases ─────────────────────────────────────────────────────────────────
  /**
   * The queue.
   *
   * Ordered server-side by severity DESC then SLA ASC — most dangerous first, and within a
   * severity the longest-waiting first. A newest-first queue starves the user who has been
   * held longest, who is also the one most likely to be a false positive.
   */
  cases(params: {
    status?: FraudCaseStatus | 'ALL';
    severity?: FraudSeverity | 'ALL';
    mine?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Paged<FraudCaseRow>> {
    return this.get<Paged<FraudCaseRow>>(
      `${API_ENDPOINTS.FRAUD.CASES}${this.query(params)}`,
    );
  }

  caseDetail(id: string): Promise<FraudCaseDetail> {
    return this.get<FraudCaseDetail>(API_ENDPOINTS.FRAUD.CASE_DETAIL(id));
  }

  /**
   * Take ownership. Atomic server-side — a 409 means another analyst won the race.
   *
   * Two analysts opening the same queue and clicking at once is routine in a shared console,
   * not hypothetical, which is why this is a conditional update rather than a read-then-write.
   */
  claimCase(id: string): Promise<{ caseId: string }> {
    return this.post<{ caseId: string }>(API_ENDPOINTS.FRAUD.CASE_CLAIM(id));
  }

  addNote(id: string, note: string): Promise<{ caseId: string }> {
    return this.post<{ caseId: string }>(API_ENDPOINTS.FRAUD.CASE_NOTE(id), {
      note,
    });
  }

  /** Ask the user for something. Pauses the SLA clock — the wait is not ours. */
  requestInfo(id: string, note: string): Promise<{ caseId: string }> {
    return this.post<{ caseId: string }>(
      API_ENDPOINTS.FRAUD.CASE_REQUEST_INFO(id),
      { note },
    );
  }

  /**
   * Decide a case, and apply the decision downstream.
   *
   * The response reports `actionApplied` separately from `status`, and the UI must show both:
   * a case can be CLEARED while the release fails because the transaction expired during
   * review. Collapsing them would tell an analyst a payment was released when it was not.
   */
  resolveCase(
    id: string,
    request: ResolveCaseRequest,
  ): Promise<ResolveCaseResult> {
    return this.post<ResolveCaseResult, ResolveCaseRequest>(
      API_ENDPOINTS.FRAUD.CASE_RESOLVE(id),
      request,
    );
  }

  // ── assessments ───────────────────────────────────────────────────────────
  assessments(params: {
    decision?: RiskDecision | 'ALL';
    subjectType?: RiskSubjectType | 'ALL';
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Paged<AdminAssessmentRow>> {
    return this.get<Paged<AdminAssessmentRow>>(
      `${API_ENDPOINTS.FRAUD.ASSESSMENTS}${this.query(params)}`,
    );
  }

  assessmentDetail(id: string): Promise<AdminRiskAssessment> {
    return this.get<AdminRiskAssessment>(
      API_ENDPOINTS.FRAUD.ASSESSMENT_DETAIL(id),
    );
  }

  // ── lists ─────────────────────────────────────────────────────────────────
  /**
   * Active listings, as COUNTS only.
   *
   * There is no endpoint that returns the entries themselves, deliberately: `valueHash` is
   * the one value in M6 that could be brute-forced offline, and shipping the list to a browser
   * would defeat the reason it is hashed. An analyst checks a specific identifier; nobody
   * needs to browse the register.
   */
  lists(): Promise<ListSummaryRow[]> {
    return this.get<ListSummaryRow[]>(API_ENDPOINTS.FRAUD.LISTS);
  }

  addListEntry(
    request: AddListEntryRequest,
  ): Promise<{ id: string; kind: string; entityType: string }> {
    return this.post<
      { id: string; kind: string; entityType: string },
      AddListEntryRequest
    >(API_ENDPOINTS.FRAUD.LISTS, request);
  }

  removeListEntry(
    request: RemoveListEntryRequest,
  ): Promise<{ removed: boolean }> {
    return this.post<{ removed: boolean }, RemoveListEntryRequest>(
      API_ENDPOINTS.FRAUD.LIST_REMOVE,
      request,
    );
  }

  // ── one user ──────────────────────────────────────────────────────────────
  /**
   * Everything M6 knows about one account, in one call.
   *
   * One endpoint rather than five because an analyst working a case needs all of it at once,
   * and five round trips is five chances to look at a stale half of the picture while
   * deciding whether to release somebody's money.
   */
  userProfile(userId: string): Promise<UserRiskProfile> {
    return this.get<UserRiskProfile>(
      API_ENDPOINTS.FRAUD.USER_PROFILE(userId),
    );
  }

  /**
   * Suspend or restore an account. The heaviest control here.
   *
   * `isSuspended` is honoured by M4's transfer path AND by the risk engine's hard gate, so one
   * flag stops payments, claims, consents and device binds rather than only transfers.
   */
  setSuspended(
    userId: string,
    suspend: boolean,
    note: string,
  ): Promise<{ userId: string; isSuspended: boolean }> {
    return this.post<{ userId: string; isSuspended: boolean }>(
      `${API_ENDPOINTS.FRAUD.USER_SUSPEND(userId)}${this.query({
        restore: suspend ? undefined : true,
      })}`,
      { note },
    );
  }

  // ── graph ─────────────────────────────────────────────────────────────────
  graph(userId: string): Promise<GraphNeighbourhood> {
    return this.get<GraphNeighbourhood>(
      API_ENDPOINTS.FRAUD.GRAPH_NEIGHBOURHOOD(userId),
    );
  }

  /**
   * Force the cluster recompute now.
   *
   * ADMIN only server-side. It exists for demos and for the first run after seeding, where
   * waiting fifteen minutes for the scheduled pass is the difference between a working
   * demonstration and a blank graph.
   */
  recomputeGraph(): Promise<GraphRecomputeResult> {
    return this.post<GraphRecomputeResult>(
      API_ENDPOINTS.FRAUD.GRAPH_RECOMPUTE,
    );
  }
}

export const fraudAdminService = new FraudAdminService();
