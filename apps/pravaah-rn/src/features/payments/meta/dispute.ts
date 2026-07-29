import type { DisputeKind } from '@/api/payments/schemas';

/**
 * UDIR's categories, in what a customer would actually say went wrong.
 *
 * Written in the first person on purpose. A dispute form is filled in by somebody who is already
 * upset, and "NOT_CREDITED" asks them to translate their problem into our vocabulary before we will
 * help. "They never received it" is the same category, chosen in one read.
 */
export const DISPUTE_KIND: Record<
  DisputeKind,
  { label: string; detail: string; needsAmount: boolean }
> = {
  NOT_CREDITED: {
    label: 'They never received it',
    detail:
      'Money left my wallet but the person I paid says nothing arrived.',
    needsAmount: false,
  },
  DUPLICATE_DEBIT: {
    label: 'I was charged twice',
    detail: 'One payment, but the money came out of my wallet more than once.',
    needsAmount: false,
  },
  WRONG_BENEFICIARY: {
    label: 'It went to the wrong person',
    detail:
      'The amount was right but it reached somebody I did not mean to pay.',
    needsAmount: false,
  },
  AMOUNT_MISMATCH: {
    label: 'The amount was wrong',
    detail: 'A different amount arrived than the one I approved.',
    needsAmount: true,
  },
  UNAUTHORISED: {
    label: 'I did not make this payment',
    detail: 'I never authorised this at all.',
    needsAmount: false,
  },
  CHARGEBACK: {
    label: 'I paid but got nothing',
    detail: 'A merchant took payment and did not deliver.',
    needsAmount: true,
  },
};
