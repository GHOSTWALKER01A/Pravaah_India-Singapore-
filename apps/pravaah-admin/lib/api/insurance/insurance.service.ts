import { z } from 'zod';

import { API_ENDPOINTS } from '@/features/endpoints';

import { APIResponseSchema } from '../core/api.schema';
import { BaseAPIService } from '../core/base-api-service';
import type {
  AdminClaim,
  AdminClaimDetail,
  AdminPolicyRow,
  AdminPremiumHistory,
  AdminProduct,
  ClaimDecisionRequest,
  ClaimDecisionResult,
  ClaimStatus,
  InsuranceBook,
  InsuranceStats,
  LifecycleResult,
  Paged,
  PolicyStatus,
  ProductActiveResult,
  RevealedDocument,
  UpsertProductRequest,
} from './insurance.schema';

/**
 * The response envelope, validated but not re-described.
 *
 * `z.custom<T>()` rather than a hand-written Zod mirror of every field, and the choice is
 * deliberate rather than lazy:
 *
 *  - The wrapper IS validated — `success`, `message`, `timestamp` and the presence of `data`
 *    all go through Zod, which is what catches a proxy returning an HTML error page or an auth
 *    redirect where JSON was expected. That is the failure this validation exists for.
 *  - Re-declaring twenty nested money and claim shapes in Zod would create a SECOND definition
 *    of the M5 contract in a third app. `insurance.schema.ts` mirrors the server's projection
 *    once; a Zod copy would have to be kept in step with both, and the first time they drifted
 *    the console would reject a valid response from a correct backend.
 *
 * The payments and scoring services describe their payloads fully because they predate the M5
 * projection and because several of their fields are re-derived client-side. Nothing here is
 * re-derived: every figure is rendered as the server sent it.
 */
const envelope = <T>() => APIResponseSchema(z.custom<T>((value) => value != null));

/**
 * M5 admin console — the book, adjudication, the estate, and the catalogue.
 *
 * Every write calls the SAME backend service the app and the schedulers use. There is
 * deliberately no admin-only payout path: a second implementation of "pay this claim" would
 * eventually pay differently, and the ledger and the claim must never disagree about how much
 * was approved. The admin routes add attribution and a required reason on top of the ordinary
 * flow, nothing more — exactly as the payments admin service documents for refunds.
 */
class InsuranceAdminService extends BaseAPIService {
  constructor() {
    super(API_ENDPOINTS.INSURANCE.BASE);
  }

  private query(params: Record<string, unknown>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      // `'ALL'` is the console's own "no filter" sentinel and must not reach the server,
      // which would reject it as an invalid enum value.
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
    const text = query.toString();
    return text ? `?${text}` : '';
  }

  // ── oversight ─────────────────────────────────────────────────────────────
  /**
   * The loss ratio and the underwriting position, per currency.
   *
   * Derived from LEDGER ENTRIES on the server, not from `PremiumPayment.status` and
   * `Claim.amountApprovedMinor`. The application tables record what we INTENDED; the ledger
   * records what moved. So this figure reconciles against M4's trial balance, and two numbers
   * that agree are what make it trustworthy rather than asserted.
   */
  async book(params: {
    currency?: string;
    type?: string;
    from?: string;
    to?: string;
  } = {}) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.INSURANCE.BOOK}${this.query(params)}`,
    );
    return envelope<InsuranceBook>().parse(raw).data;
  }

  /** Portfolio counts, the conversion funnel, and the operational alarms. */
  async stats() {
    const raw = await this.get<unknown>(API_ENDPOINTS.INSURANCE.STATS);
    return envelope<InsuranceStats>().parse(raw).data;
  }

  /**
   * Force every lifecycle sweep now.
   *
   * The same crons that run on a schedule — quote expiry, premium dunning, term expiry,
   * resuming stuck money, retrying unpaid payouts. Exposed so an operator can prove the
   * dunning path works rather than waiting an hour for the next tick, and so a stuck premium
   * can be nudged without a deploy.
   */
  async runLifecycle() {
    const raw = await this.post<unknown>(
      API_ENDPOINTS.INSURANCE.RUN_LIFECYCLE,
      {},
    );
    return envelope<LifecycleResult>().parse(raw).data;
  }

  // ── adjudication ──────────────────────────────────────────────────────────
  /**
   * The claim queue. OLDEST first, server-side.
   *
   * A newest-first queue starves the longest-waiting claimant, which for somebody holding a
   * hospital bill is the difference between a working product and an abandoned one.
   */
  async claims(params: {
    status?: ClaimStatus | 'ALL';
    flaggedOnly?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.INSURANCE.CLAIMS}${this.query(params)}`,
    );
    // `paginatedWithOffset`, so the items sit inside `data` alongside the page metadata.
    return envelope<Paged<AdminClaim>>().parse(raw).data;
  }

  async claimDetail(id: string) {
    const raw = await this.get<unknown>(
      API_ENDPOINTS.INSURANCE.CLAIM_DETAIL(id),
    );
    return envelope<AdminClaimDetail>().parse(raw).data;
  }

  /**
   * Decide a claim.
   *
   * On APPROVE the payout posts over the M4 ledger, idempotent on `claim-payout:{claimId}`. If
   * it fails the claim stays APPROVED and RETRYABLE — there is deliberately no
   * APPROVED → REJECTED edge, because once a claimant has been told their claim is approved it
   * cannot be walked back for a payout error. The money is owed; only the timing is open.
   */
  async decide(id: string, body: ClaimDecisionRequest) {
    const raw = await this.post<unknown, ClaimDecisionRequest>(
      API_ENDPOINTS.INSURANCE.CLAIM_DECIDE(id),
      body,
    );
    // The OUTCOME, not the whole claim — see `ClaimDecisionResult`. The caller invalidates
    // the detail query rather than trusting a partial row.
    return envelope<ClaimDecisionResult>().parse(raw).data;
  }

  /**
   * Decrypt one document's OCR extraction.
   *
   * A GET, matching the route the server actually exposes. It still writes its own audit row
   * naming the admin, and it is still gated to SENIOR_REVIEWER and above — the attribution comes
   * from the handler rather than from the verb.
   *
   * It is deliberately NOT part of the claim-detail payload. A hospital bill names a diagnosis
   * and a treating physician; rendering it on every queue load would attribute a read to anybody
   * who scrolled past, which destroys the value of the audit trail. So the console calls this
   * only when a reviewer explicitly asks, and never on mount.
   */
  async revealDocument(docId: string) {
    const raw = await this.get<unknown>(
      API_ENDPOINTS.INSURANCE.DOCUMENT_REVEAL(docId),
    );
    return envelope<RevealedDocument>().parse(raw).data;
  }

  // ── the estate ────────────────────────────────────────────────────────────
  async policies(params: {
    status?: PolicyStatus | 'ALL';
    type?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }) {
    const raw = await this.get<unknown>(
      `${API_ENDPOINTS.INSURANCE.POLICIES}${this.query(params)}`,
    );
    return envelope<Paged<AdminPolicyRow>>().parse(raw).data;
  }

  /**
   * Each premium period on one policy. The document a support call is argued from.
   *
   * Arrives as `{ policyNumber, items }` rather than a bare array — the policy number travels
   * with the history so a support conversation can be opened from the response alone.
   */
  async premiums(policyId: string) {
    const raw = await this.get<unknown>(
      API_ENDPOINTS.INSURANCE.POLICY_PREMIUMS(policyId),
    );
    return envelope<AdminPremiumHistory>().parse(raw).data;
  }

  // ── the catalogue ─────────────────────────────────────────────────────────
  async products() {
    const raw = await this.get<unknown>(API_ENDPOINTS.INSURANCE.PRODUCTS);
    return envelope<AdminProduct[]>().parse(raw).data;
  }

  /**
   * Add a cover. No deploy needed.
   *
   * The server refuses a product that would be unsafe to sell — a waiting period longer than
   * the term could never pay a claim, and a zero waiting period on income protection makes
   * buying after the incident rational. Those come back as 400s with the reason, which the
   * form shows verbatim rather than replacing with "invalid input".
   */
  async createProduct(body: UpsertProductRequest) {
    const raw = await this.post<unknown, UpsertProductRequest>(
      API_ENDPOINTS.INSURANCE.PRODUCTS,
      body,
    );
    return envelope<AdminProduct>().parse(raw).data;
  }

  /**
   * Retire or restore a cover.
   *
   * A flag, never a delete. Policies sold on a product have to keep resolving their terms for
   * as long as a claim can be filed against them, and a deleted catalogue row would leave a
   * live policy pointing at nothing.
   */
  async setProductActive(id: string, isActive: boolean) {
    // POST, matching the route the server exposes — and it answers with the flag alone, not
    // the whole product, so the caller invalidates rather than merging a partial row.
    const raw = await this.post<unknown, { isActive: boolean }>(
      API_ENDPOINTS.INSURANCE.PRODUCT_ACTIVE(id),
      { isActive },
    );
    return envelope<ProductActiveResult>().parse(raw).data;
  }
}

export const insuranceAdminService = new InsuranceAdminService();
