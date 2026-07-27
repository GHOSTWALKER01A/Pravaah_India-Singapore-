/**
 * M1 · Account Aggregator consent types (mirror pravaah-be). The RN app talks to
 * the same NestJS routes; these shapes match the ResponseBuilder `data` bodies.
 */

export type FiType =
  | 'DEPOSIT'
  | 'TERM_DEPOSIT'
  | 'RECURRING_DEPOSIT'
  | 'MUTUAL_FUNDS'
  | 'EQUITIES'
  | 'GSTR';

export type FetchType = 'ONETIME' | 'PERIODIC';

export type DataLifeUnit = 'MONTH' | 'YEAR' | 'INF';

export type ConsentStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'REJECTED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'FAILED';

export type DataSessionStatus =
  | 'PENDING'
  | 'PARTIAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

/** POST /consent/create body. */
export interface CreateConsentRequest {
  fiTypes: FiType[];
  purpose: string;
  purposeCode: string;
  fetchType: FetchType;
  frequency?: { unit: 'DAY' | 'MONTH'; value: number };
  dataRange: { from: string; to: string };
  dataLife: { unit: DataLifeUnit; value: number };
  /** Deep link the AA redirects to after approval so the browser auto-closes. */
  redirectUrl?: string;
}

/** POST /consent/create → the AA approval handle. */
export interface CreateConsentData {
  consentId: string;
  providerConsentId: string | null;
  approvalUrl: string | null;
  reuseExisting?: boolean;
}

/** GET /consent → one row per consent (the dashboard). */
export interface ConsentSummary {
  id: string;
  purpose: string;
  purposeCode: string;
  fiTypes: FiType[];
  status: ConsentStatus;
  fetchType: FetchType;
  dataRangeFrom: string;
  dataRangeTo: string;
  dataLifeUnit: DataLifeUnit;
  dataLifeValue: number;
  expiresAt: string | null;
  activatedAt: string | null;
  revokedAt: string | null;
  artefactVerified: boolean;
  createdAt: string;
}

export interface DataSessionSummary {
  status: DataSessionStatus;
  fipTotal: number | null;
  fipCompleted: number;
  coverage: number | null;
  completedAt: string | null;
  dataPurged: boolean;
}

/** GET /consent/:id/status → rich status + latest data-session coverage. */
export interface ConsentStatusData {
  id: string;
  status: ConsentStatus;
  artefactVerified: boolean;
  fiTypes: FiType[];
  expiresAt: string | null;
  featuresAvailable: number;
  dataSession: DataSessionSummary | null;
}

/** A consent whose id wasn't found for this user. */
export type ConsentStatusResult = ConsentStatusData | { status: 'NOT_FOUND' };
