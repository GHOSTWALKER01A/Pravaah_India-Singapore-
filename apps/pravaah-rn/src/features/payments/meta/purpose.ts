import type {
  Corridor,
  PurposeCode,
  TransferType,
} from '@/api/payments/schemas';

/** Why the money is moving, and what the corridor makes of that. */

export const PURPOSE_LABEL: Record<PurposeCode, string> = {
  P2P_TRANSFER: 'Money transfer',
  MERCHANT_PAYMENT: 'Merchant payment',
  LOAN_DISBURSAL: 'Loan disbursal',
  LOAN_REPAYMENT: 'Loan repayment',
  INSURANCE_PREMIUM: 'Insurance premium',
  WALLET_TOPUP: 'Add money',
  WALLET_WITHDRAWAL: 'Withdraw to bank',
  P1301: 'Family maintenance',
  P1302: 'Gift or donation',
  P0103: 'Travel',
  P1007: 'Education',
  P1006: 'Medical treatment',
  P1401: 'Loan repayment abroad',
};

/**
 * The purposes offered per corridor.
 *
 * Split because the server REJECTS a mismatch: a cross-border transfer must carry an RBI/FEMA purpose
 * code, and a domestic one must not. Offering the wrong list would put a 400 in front of a user who
 * did nothing wrong.
 */
export const CROSS_BORDER_PURPOSES: readonly PurposeCode[] = [
  'P1301',
  'P1302',
  'P1007',
  'P1006',
  'P0103',
  'P1401',
];

export const DOMESTIC_PURPOSES: readonly PurposeCode[] = [
  'P2P_TRANSFER',
  'MERCHANT_PAYMENT',
  'LOAN_REPAYMENT',
  'INSURANCE_PREMIUM',
];

export function purposesFor(corridor: Corridor): readonly PurposeCode[] {
  return corridor === 'CROSS_BORDER'
    ? CROSS_BORDER_PURPOSES
    : DOMESTIC_PURPOSES;
}

/**
 * The transfer type implied by a purpose.
 *
 * Derived rather than asked, because the user has already told us: somebody choosing "family
 * maintenance" on the cross-border corridor is making a remittance, and putting a second dropdown in
 * front of them to say so again is a tap that carries no information.
 */
export function typeForPurpose(
  purpose: PurposeCode,
  corridor: Corridor,
): TransferType {
  if (corridor === 'CROSS_BORDER') return 'REMITTANCE';
  switch (purpose) {
    case 'MERCHANT_PAYMENT':
      return 'P2M';
    case 'LOAN_REPAYMENT':
      return 'REPAYMENT';
    case 'INSURANCE_PREMIUM':
      return 'PREMIUM';
    default:
      return 'P2P';
  }
}

export const CORRIDOR_META: Record<
  Corridor,
  { label: string; stamp: string; detail: string }
> = {
  DOMESTIC: {
    label: 'Within India',
    /** The note's multi-language panel device, reduced to the corridor stamp. */
    stamp: 'IN',
    detail: 'Instant over UPI. No fee.',
  },
  CROSS_BORDER: {
    label: 'Singapore to India',
    stamp: 'SG → IN',
    detail: 'Over the UPI–PayNow link. A fee and an exchange rate apply.',
  },
};
