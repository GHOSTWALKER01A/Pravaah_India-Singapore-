import type { MandateFrequency } from '@/api/payments/schemas';

/** AutoPay schedules, in the words a payer would use. */
export const MANDATE_FREQUENCY: Record<
  MandateFrequency,
  { label: string; detail: string }
> = {
  ONETIME: { label: 'Once', detail: 'A single debit on the date you choose.' },
  DAILY: { label: 'Every day', detail: 'One debit a day.' },
  WEEKLY: { label: 'Every week', detail: 'One debit a week.' },
  FORTNIGHTLY: {
    label: 'Every two weeks',
    detail: 'One debit every fortnight.',
  },
  MONTHLY: {
    label: 'Every month',
    detail: 'One debit a month, on the same date.',
  },
  BIMONTHLY: {
    label: 'Every two months',
    detail: 'One debit every two months.',
  },
  QUARTERLY: { label: 'Every three months', detail: 'One debit a quarter.' },
  HALFYEARLY: { label: 'Every six months', detail: 'Two debits a year.' },
  YEARLY: { label: 'Every year', detail: 'One debit a year.' },
  /**
   * The one that needs its detail read.
   *
   * `AS_PRESENTED` has no schedule at all, so the only thing bounding it is the cap the payer set.
   * Saying "no fixed schedule" without naming the limit would describe an open-ended authorisation
   * as if it were a subscription.
   */
  AS_PRESENTED: {
    label: 'When they ask',
    detail:
      'No fixed schedule. They present a debit when one is due, up to your limit.',
  },
};
