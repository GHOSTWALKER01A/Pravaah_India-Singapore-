export type KycStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'ACTION_REQUIRED'
  | 'VERIFIED'
  | 'REJECTED';

export type Country = 'INDIA' | 'SINGAPORE' | 'BOTH';

export type CheckType =
  | 'PAN'
  | 'AADHAAR_OKYC'
  | 'BANK_PENNY_DROP'
  | 'FACE_MATCH'
  | 'LIVENESS'
  | 'SINGPASS_MYINFO'
  | 'SANCTIONS_PEP';

export type CheckStatus =
  | 'PENDING'
  | 'PASSED'
  | 'FAILED'
  | 'MANUAL_REVIEW'
  | 'EXPIRED';

export interface KycCheck {
  checkType: CheckType;
  status: CheckStatus;
  provider?: string;
  confidence?: number | null;
  updatedAt?: string;
}

export interface KycProfileStatus {
  overallStatus: KycStatus;
  country: Country;
  verifiedName?: string | null;
  nameMatchScore?: number | null;
  riskScore?: number | null;
  completedAt?: string | null;
  checks: KycCheck[];
}

/** Request payloads for the individual India check steps. */
export interface PanVerifyRequest {
  pan: string;
}
export interface BankVerifyRequest {
  accountNumber: string;
  ifsc: string;
  /** Debit/credit card validity (expiry) in MM/YY. */
  cardValidity: string;
}
/** DigiLocker / Singpass initiate returns a URL to open in a browser. */
export interface RedirectInitiateData {
  providerRefId: string;
  authorizationUrl: string;
}

/** A Singpass Myinfo test persona the user can pick in the mock consent flow. */
export interface Persona {
  uinfin: string;
  name: string;
  dob: string;
  nationality: string;
  address: string;
  employment?: string;
}

export interface PersonaListData {
  providerRefId: string;
  personas: Persona[];
}

/** Active-liveness gesture prompts (mirrors the backend LIVENESS_GESTURES). */
export type LivenessGesture =
  | 'BLINK'
  | 'TURN_LEFT'
  | 'TURN_RIGHT'
  | 'SMILE'
  | 'NOD';

/** POST /liveness/session → a session id + the randomized challenge to perform. */
export interface LivenessSessionData {
  sessionId: string;
  challenge: LivenessGesture[];
}
