import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import {
  BankVerifyRequest,
  KycProfileStatus,
  LivenessGesture,
  LivenessSessionData,
  PanVerifyRequest,
  PersonaListData,
  RedirectInitiateData,
} from './kyc.schema';

/**
 * Build the file part for a captured image URI. React Native's FormData accepts
 * a `{ uri, name, type }` descriptor where the web expects a Blob, so we cast.
 */
function imagePart(uri: string, name: string): Blob {
  return { uri, name, type: 'image/jpeg' } as unknown as Blob;
}

class KycService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.KYC.BASE);
  }

  /** Create (or resume) the KYC profile for the signed-in user. */
  start(country: string): Promise<KycProfileStatus> {
    return this.post<KycProfileStatus>(API_ENDPOINTS.KYC.START, { country });
  }

  getStatus(): Promise<KycProfileStatus> {
    return this.get<KycProfileStatus>(API_ENDPOINTS.KYC.STATUS);
  }

  // ── India rail ────────────────────────────────────────────────────────────
  verifyPan(request: PanVerifyRequest): Promise<KycProfileStatus> {
    return this.post<KycProfileStatus>(API_ENDPOINTS.KYC.PAN_VERIFY, {
      pan: request.pan.toUpperCase(),
    });
  }

  initiateAadhaarOkyc(): Promise<RedirectInitiateData> {
    return this.post<RedirectInitiateData>(API_ENDPOINTS.KYC.AADHAAR_INITIATE);
  }

  /**
   * Complete OKYC after the user finishes the DigiLocker consent.
   *
   * @param code The access code shown on the provider's completion page. Sent
   * only when present — a session that redirected back does not produce one.
   */
  completeAadhaarOkyc(
    providerRefId: string,
    code?: string,
  ): Promise<KycProfileStatus> {
    return this.post<KycProfileStatus>(API_ENDPOINTS.KYC.AADHAAR_CALLBACK, {
      providerRefId,
      ...(code ? { code } : {}),
    });
  }

  bankPennyDrop(request: BankVerifyRequest): Promise<KycProfileStatus> {
    // Backend PennyDropSchema expects `account` (not `accountNumber`).
    return this.post<KycProfileStatus>(API_ENDPOINTS.KYC.BANK_PENNY_DROP, {
      account: request.accountNumber,
      ifsc: request.ifsc.toUpperCase(),
      cardValidity: request.cardValidity,
    });
  }

  // ── Singapore rail ──────────────────────────────────────────────────────────
  initiateSingpass(): Promise<RedirectInitiateData> {
    return this.post<RedirectInitiateData>(API_ENDPOINTS.KYC.SINGPASS_INITIATE);
  }

  /** Dev persona consent screen: list the official test personas. */
  listPersonas(providerRefId: string): Promise<PersonaListData> {
    return this.get<PersonaListData>(
      API_ENDPOINTS.KYC.SINGPASS_MOCK(providerRefId),
      false,
    );
  }

  /** Dev persona consent screen: bind the chosen persona to the session. */
  selectPersona(
    providerRefId: string,
    uinfin: string,
  ): Promise<{ providerRefId: string; uinfin: string }> {
    return this.post(API_ENDPOINTS.KYC.SINGPASS_MOCK(providerRefId), { uinfin }, false);
  }

  /** Fetch the consented Myinfo profile and record the check. */
  completeSingpass(providerRefId: string): Promise<KycProfileStatus> {
    return this.post<KycProfileStatus>(API_ENDPOINTS.KYC.SINGPASS_CALLBACK, {
      providerRefId,
    });
  }

  // ── Shared biometrics + screening ───────────────────────────────────────────
  /** Start an active-liveness session; returns the randomized gesture challenge. */
  createLivenessSession(): Promise<LivenessSessionData> {
    return this.post<LivenessSessionData>(API_ENDPOINTS.KYC.LIVENESS_SESSION);
  }

  /**
   * Submit the captured selfie frame plus the challenge the user completed. The
   * server verifies the sequence matches the one it issued (anti-replay) and
   * that a real frame was captured.
   */
  verifyLiveness(
    sessionId: string,
    selfieUri: string,
    challenge: LivenessGesture[],
  ): Promise<KycProfileStatus> {
    const form = new FormData();
    form.append('selfie', imagePart(selfieUri, 'liveness.jpg'));
    form.append('sessionId', sessionId);
    form.append('challenge', challenge.join(','));
    return this.postForm<KycProfileStatus>(
      API_ENDPOINTS.KYC.LIVENESS_VERIFY,
      form,
    );
  }

  /** Selfie ↔ document face match. Uploads both captured images (multipart). */
  faceMatch(selfieUri: string, idPhotoUri: string): Promise<KycProfileStatus> {
    const form = new FormData();
    form.append('selfie', imagePart(selfieUri, 'selfie.jpg'));
    form.append('idPhoto', imagePart(idPhotoUri, 'id-photo.jpg'));
    return this.postForm<KycProfileStatus>(API_ENDPOINTS.KYC.FACE_MATCH, form);
  }

  /** Sanctions / PEP screen of the reconciled name. */
  screenSanctions(): Promise<KycProfileStatus> {
    return this.post<KycProfileStatus>(API_ENDPOINTS.KYC.SANCTIONS, {});
  }

  /** Register this device's Expo push token for decision notifications. */
  registerPushToken(token: string): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>(API_ENDPOINTS.KYC.PUSH_TOKEN, { token });
  }
}

export const kycService = new KycService();
