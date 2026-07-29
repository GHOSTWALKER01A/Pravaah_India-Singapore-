import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  BuyPolicyRequest,
  BuyPolicyResult,
  CancelPolicyResult,
  InsuranceProduct,
  InsuranceQuote,
  Policy,
  PremiumPayment,
  QuoteRequest,
} from '../schemas';
import { toQuery } from '@/api/payments/services/query';

/**
 * The insurance product: browse, get priced, buy, hold.
 *
 * Bound to `API_ENDPOINTS.INSURANCE.BASE`. Claims are a separate service on their own
 * base path — see `claims.service.ts` — because `BaseApiService` binds exactly one, and
 * merging them would mean hand-writing absolute paths and losing that guarantee.
 *
 * ## Where the idempotency key comes from
 *
 * `buy` and `retryPremium` take the key as an EXPLICIT argument, exactly as every M4
 * mutation does. The key is minted by `useIdempotencyKey` when the user forms the
 * intent — never inside a method here. Minting it in a service would give a retried
 * submit a fresh key, and the server would correctly read that as a second purchase and
 * debit the holder twice for one month of cover.
 */
class InsuranceService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.INSURANCE.BASE);
  }

  /**
   * The marketplace.
   *
   * Returns cover bands and terms and NO premiums. Not an omission — pricing is
   * personal, so a marketplace price would either be a lie or an average nobody is
   * actually offered.
   */
  products(
    params: { type?: string; currency?: string } = {},
  ): Promise<InsuranceProduct[]> {
    return this.get<InsuranceProduct[]>(
      `${API_ENDPOINTS.INSURANCE.PRODUCTS}${toQuery(params)}`,
    );
  }

  product(id: string): Promise<InsuranceProduct> {
    return this.get<InsuranceProduct>(
      API_ENDPOINTS.INSURANCE.PRODUCT_DETAIL(id),
    );
  }

  /**
   * Ask for a price.
   *
   * A DECLINE comes back on a 200 with `riskTier: 'DECLINE'` and a `declineReason`,
   * not as a thrown error. That is deliberate on the server and must stay deliberate
   * here: a decline carries a reason and a route back to eligibility, and turning it
   * into a caught exception would collapse it into the blank refusal this population
   * already gets everywhere else.
   */
  quote(request: QuoteRequest): Promise<InsuranceQuote> {
    return this.post<InsuranceQuote>(API_ENDPOINTS.INSURANCE.QUOTE, request);
  }

  getQuote(id: string): Promise<InsuranceQuote> {
    return this.get<InsuranceQuote>(API_ENDPOINTS.INSURANCE.QUOTE_DETAIL(id));
  }

  /**
   * Buy the cover a quote priced.
   *
   * `collected: false` in the result is NOT a failure to handle as an error — it is the
   * ordinary case for this product. The policy exists at the agreed price and is
   * awaiting a premium the wallet could not fund; the caller shows the shortfall and
   * offers a top-up.
   */
  buy(
    idempotencyKey: string,
    request: BuyPolicyRequest,
  ): Promise<BuyPolicyResult> {
    return this.postIdempotent<BuyPolicyResult>(
      API_ENDPOINTS.INSURANCE.POLICIES,
      idempotencyKey,
      request,
    );
  }

  policies(
    params: { activeOnly?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ items: Policy[]; total: number }> {
    return this.get<{ items: Policy[]; total: number }>(
      `${API_ENDPOINTS.INSURANCE.POLICIES}${toQuery(params)}`,
    );
  }

  policy(id: string): Promise<Policy> {
    return this.get<Policy>(API_ENDPOINTS.INSURANCE.POLICY_DETAIL(id));
  }

  /** Each premium period and what happened to it. The support-call document. */
  premiums(id: string): Promise<PremiumPayment[]> {
    return this.get<PremiumPayment[]>(
      API_ENDPOINTS.INSURANCE.POLICY_PREMIUMS(id),
    );
  }

  /**
   * Cancel.
   *
   * Whether a refund follows is decided by the SERVER from the policy's own
   * `freeLookEndsAt`, never by the client asking for one. The result reports what
   * actually happened.
   */
  cancel(id: string, reason?: string): Promise<CancelPolicyResult> {
    return this.post<CancelPolicyResult>(
      API_ENDPOINTS.INSURANCE.POLICY_CANCEL(id),
      reason ? { reason } : {},
    );
  }

  /** Retry a first premium after the wallet has been topped up. */
  retryPremium(
    id: string,
    idempotencyKey: string,
  ): Promise<BuyPolicyResult> {
    return this.postIdempotent<BuyPolicyResult>(
      API_ENDPOINTS.INSURANCE.POLICY_RETRY_PREMIUM(id),
      idempotencyKey,
      {},
    );
  }
}

export const insuranceService = new InsuranceService();
