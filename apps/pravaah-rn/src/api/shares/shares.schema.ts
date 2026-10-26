/**
 * M7 · Consent receipts — "who has seen my passport". Mirrors the `/passport/shares`
 * routes in pravaah-be (`holder-shares.controller.ts` → `ConsentReceiptService`).
 *
 * A receipt is issued for every share the holder approved for a registered ORGANISATION
 * (a lender, insurer, employer, landlord). It records claim NAMES only — never the values
 * — so the list is safe to render and cache without holding the data it describes.
 */

/**
 *   ACTIVE     the organisation holds what was shared, within its retention promise
 *   WITHDRAWN  the holder withdrew; our copy is redacted and the organisation told to delete
 *   EXPIRED    the retention term ran out and our copy was deleted on schedule
 */
export type ShareReceiptStatus = 'ACTIVE' | 'WITHDRAWN' | 'EXPIRED';

export type PartnerType =
  | 'LENDER'
  | 'INSURER'
  | 'EMPLOYER'
  | 'LANDLORD'
  | 'BANK'
  | 'OTHER';

export type PartnerDecision = 'APPROVED' | 'DECLINED' | 'REFERRED';

/**
 * The organisation, as it was when the holder said yes.
 *
 * `name` and `domain` are SNAPSHOTTED on the receipt server-side: a receipt is a record
 * of what the holder was shown, and it must not change if the organisation renames.
 */
export interface ShareCounterparty {
  name: string;
  domain: string | null;
  type: PartnerType;
  country: string | null;
  /** False once PRAVAAH has suspended or revoked the organisation. */
  stillApproved: boolean;
}

export interface ShareReceipt {
  id: string;
  requestId: string;
  partner: ShareCounterparty;
  purpose: string;
  claimsShared: { claim: string; label: string }[];
  /** Asked for and deliberately not sent. */
  claimsWithheld: string[];
  /** Yes/no questions this share answered, e.g. `score_band:GTE:GOOD`. */
  predicatesAnswered: string[];
  retentionDays: number;
  status: ShareReceiptStatus;
  issuedAt: string;
  withdrawnAt: string | null;
  /** When PRAVAAH's cached copy was actually deleted. Null until it has been. */
  dataDeletedAt: string | null;
  /** When it is scheduled to be deleted. */
  deletesOn: string;
  canWithdraw: boolean;
}

/** GET /passport/shares/:id — the receipt plus how the share happened and what came of it. */
export interface ShareReceiptDetail extends ShareReceipt {
  channel: 'QR' | 'NFC' | 'DEEPLINK' | 'API';
  requestedAt: string;
  /**
   * The outcome the organisation recorded — never its notes or reasons, which are its own.
   * Null until it records one.
   */
  partnerDecision: { decision: PartnerDecision; decidedAt: string } | null;
}

/** POST /passport/shares/:id/withdraw */
export interface WithdrawShareResult {
  id: string;
  status: 'WITHDRAWN';
  withdrawnAt: string;
  /** True when the organisation has a webhook, so it was told immediately. */
  partnerNotified: boolean;
}

/** `ResponseBuilder.paginatedWithOffset` body. */
export interface PageOf<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore?: boolean;
}
