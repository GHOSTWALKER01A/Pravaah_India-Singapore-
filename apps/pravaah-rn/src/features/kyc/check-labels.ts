import type { CheckType } from '@/api';

/** Human-friendly labels + descriptions for each KYC check. */
export const CHECK_META: Record<CheckType, { label: string; subtitle: string }> = {
  PAN: { label: 'PAN verification', subtitle: 'Income-tax identity (India)' },
  AADHAAR_OKYC: { label: 'Aadhaar OKYC', subtitle: 'DigiLocker offline KYC (India)' },
  BANK_PENNY_DROP: { label: 'Bank account', subtitle: 'Penny-drop name match (India)' },
  FACE_MATCH: { label: 'Face match', subtitle: 'Selfie vs. document photo' },
  LIVENESS: { label: 'Liveness', subtitle: 'Confirm you are a real person' },
  SINGPASS_MYINFO: { label: 'Singpass Myinfo', subtitle: 'Government identity (Singapore)' },
  SANCTIONS_PEP: { label: 'Sanctions & PEP', subtitle: 'Global watchlist screening' },
};
