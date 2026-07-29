import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  AddBeneficiaryRequest,
  BeneficiaryHandleType,
  BeneficiaryStatus,
  BeneficiaryView,
  Paged,
  ResolvedMobile,
  ResolvedPayee,
} from '../schemas';
import { toQuery } from './query';

/** Payees, and the name check. */
class BeneficiaryService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.BENEFICIARIES.BASE);
  }

  /**
   * Resolve a UPI ID to the name its bank holds. No money moves.
   *
   * Its own call because it must happen BEFORE the decision it informs. Folded into the transfer,
   * the name would arrive after the user had already committed.
   */
  resolve(vpa: string): Promise<ResolvedPayee> {
    return this.post<ResolvedPayee>(API_ENDPOINTS.BENEFICIARIES.RESOLVE, {
      vpa,
    });
  }

  /**
   * Resolve a MOBILE NUMBER to payable addresses.
   *
   * `country` is required, never inferred from the digits. `8123456789` is a valid Indian mobile and
   * also a Singapore number with a stray digit, so guessing would sometimes pay a stranger in the
   * wrong country over an irreversible rail. The screen always asks.
   */
  resolveMobile(request: {
    phone: string;
    country: 'IN' | 'SG';
  }): Promise<ResolvedMobile> {
    return this.post<ResolvedMobile>(
      API_ENDPOINTS.BENEFICIARIES.RESOLVE_MOBILE,
      request,
    );
  }

  /**
   * The payee list.
   *
   * `status` and `handleType` are typed against the shared vocabulary rather than `string`, so a
   * screen cannot filter on a value the backend's enum will reject at runtime.
   */
  list(
    params: {
      status?: BeneficiaryStatus;
      handleType?: BeneficiaryHandleType;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Paged<BeneficiaryView>> {
    return this.get<Paged<BeneficiaryView>>(
      `${API_ENDPOINTS.BENEFICIARIES.LIST}${toQuery(params)}`,
    );
  }

  add(request: AddBeneficiaryRequest): Promise<BeneficiaryView> {
    return this.post<BeneficiaryView>(API_ENDPOINTS.BENEFICIARIES.ADD, request);
  }

  detail(id: string): Promise<BeneficiaryView> {
    return this.get<BeneficiaryView>(API_ENDPOINTS.BENEFICIARIES.DETAIL(id));
  }

  /** Re-run the name check. Also restarts the new-payee cooling period. */
  reverify(id: string): Promise<BeneficiaryView> {
    return this.post<BeneficiaryView>(API_ENDPOINTS.BENEFICIARIES.REVERIFY(id));
  }

  /** Block a payee — distinct from removing one, which could be undone in seconds. */
  block(id: string, reason?: string): Promise<BeneficiaryView> {
    return this.post<BeneficiaryView>(
      API_ENDPOINTS.BENEFICIARIES.BLOCK(id),
      reason ? { reason } : {},
    );
  }

  unblock(id: string): Promise<BeneficiaryView> {
    return this.post<BeneficiaryView>(API_ENDPOINTS.BENEFICIARIES.UNBLOCK(id));
  }

  remove(id: string): Promise<{ id: string }> {
    return this.delete<{ id: string }>(API_ENDPOINTS.BENEFICIARIES.DETAIL(id));
  }
}

export const beneficiaryService = new BeneficiaryService();
