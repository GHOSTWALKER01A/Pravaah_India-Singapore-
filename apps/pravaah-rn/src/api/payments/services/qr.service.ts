import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import type {
  PaymentQrView,
  PurposeCode,
  QrKind,
  ScannedQrView,
  TransactionView,
} from '../schemas';

/** QR codes — minting our own, and decoding the ones we are handed. */
class PaymentQrService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.PAYMENT_QR.BASE);
  }

  create(request: {
    kind: QrKind;
    amountMinor?: string;
    currency?: string;
    purposeCode: PurposeCode;
    mcc?: string;
    narration?: string;
    expiresInSeconds?: number;
  }): Promise<PaymentQrView> {
    return this.post<PaymentQrView>(API_ENDPOINTS.PAYMENT_QR.CREATE, request);
  }

  list(): Promise<PaymentQrView[]> {
    return this.get<PaymentQrView[]>(API_ENDPOINTS.PAYMENT_QR.LIST);
  }

  /**
   * Decode a scanned payload SERVER-SIDE.
   *
   * A QR is attacker-supplied input that resolves to a payee. Two parsers — ours and the app's —
   * that disagree about a malformed one are two different answers to "who gets the money", so there
   * is exactly one parser and it is not in this app.
   */
  scan(payload: string): Promise<ScannedQrView> {
    return this.post<ScannedQrView>(API_ENDPOINTS.PAYMENT_QR.SCAN, { payload });
  }

  pay(
    idempotencyKey: string,
    request: {
      payload: string;
      quoteId: string;
      expectedTotalDebitMinor: string;
      confirmedRegisteredName: string;
      confirmedName: true;
      narration?: string;
      deviceId?: string;
    },
  ): Promise<TransactionView> {
    return this.postIdempotent<TransactionView>(
      API_ENDPOINTS.PAYMENT_QR.PAY,
      idempotencyKey,
      request,
    );
  }

  deactivate(id: string): Promise<PaymentQrView> {
    return this.post<PaymentQrView>(API_ENDPOINTS.PAYMENT_QR.DEACTIVATE(id));
  }
}

export const paymentQrService = new PaymentQrService();
