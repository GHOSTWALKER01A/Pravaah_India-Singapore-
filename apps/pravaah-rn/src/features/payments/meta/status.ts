import type { TxnStatus } from '@/api/payments/schemas';

/**
 * How every one of the saga's fourteen states is presented to a person.
 *
 * Two things this file refuses to do, both of which the backend already decided:
 *
 * 1. **It never invents a status colour.** Tones map onto the note's own two-colour system —
 *    `field` for cleared, `latent` for in flight, `carmine` for the word under pressure, `neutral`
 *    for dormant. There is no success-green / warning-amber rainbow to reach for.
 * 2. **It never renders DEEMED as a failure.** The rail did not answer; the money is in suspense
 *    and safe. A screen that styled it carmine would tell a user their money is gone when it is
 *    not, which is the single worst thing this UI could say.
 */

export type PaymentTone = 'field' | 'latent' | 'carmine' | 'neutral';

export interface StatusPresentation {
  /** What the user reads. Written for a person, not a log. */
  label: string;
  tone: PaymentTone;
  /** One sentence saying what is true now, and what happens next if anything. */
  detail: string;
  /** Whether the app should keep polling. Mirrors the server's `isFinal`, as a fallback. */
  inFlight: boolean;
  /**
   * Whether the money has left the user's wallet AS FAR AS THE USER IS CONCERNED.
   *
   * True for the in-flight states too, because the balance really has dropped — the funds sit in
   * suspense. Showing "not yet debited" while the balance has moved is how a user double-pays.
   */
  debited: boolean;
}

/**
 * A `Record`, not a lookup with a fallback.
 *
 * Adding a state to the backend enum makes this file fail to compile instead of silently rendering
 * a raw `SCREAMING_CASE` token at a user who is trying to work out where their money is. The
 * vocabulary now comes from `@pravaah/schema`, so that compile break is guaranteed rather than
 * hoped for.
 */
export const TXN_STATUS: Record<TxnStatus, StatusPresentation> = {
  INITIATED: {
    label: 'Starting',
    tone: 'latent',
    detail: 'We have your instruction and are checking it.',
    inFlight: true,
    debited: false,
  },
  VALIDATED: {
    label: 'Checked',
    tone: 'latent',
    detail: 'Everything checks out. Reserving the money now.',
    inFlight: true,
    debited: false,
  },
  RISK_HELD: {
    label: 'On hold',
    tone: 'latent',
    detail:
      'We are reviewing this payment for your safety. Nothing has left your wallet, and we will be in touch shortly.',
    inFlight: true,
    debited: false,
  },
  AWAITING_APPROVAL: {
    label: 'Waiting for them',
    tone: 'latent',
    detail: 'The payer has to approve this in their own UPI app.',
    inFlight: true,
    debited: false,
  },
  RESERVED: {
    label: 'Held',
    tone: 'latent',
    detail: 'The money is set aside and on its way to the payment network.',
    inFlight: true,
    debited: true,
  },
  SUBMITTED: {
    label: 'Sent to the network',
    tone: 'latent',
    detail: 'The payment network has it. Not received yet.',
    inFlight: true,
    debited: true,
  },
  PENDING: {
    label: 'Clearing',
    tone: 'latent',
    detail: 'The network is settling this. It usually takes a few seconds.',
    inFlight: true,
    debited: true,
  },
  SUCCESS: {
    label: 'Paid',
    tone: 'field',
    detail: 'The money reached them.',
    inFlight: false,
    debited: true,
  },
  FAILED: {
    label: 'Not paid',
    tone: 'carmine',
    detail: 'This did not go through and your money is back in your wallet.',
    inFlight: false,
    debited: false,
  },
  REVERSED: {
    label: 'Returned',
    tone: 'carmine',
    detail:
      'Nothing left your wallet. The amount that was held has been released.',
    inFlight: false,
    debited: false,
  },
  REFUNDED: {
    label: 'Refunded',
    tone: 'carmine',
    detail: 'The full amount has come back to your wallet.',
    inFlight: false,
    debited: false,
  },
  PARTIALLY_REFUNDED: {
    label: 'Partly refunded',
    tone: 'latent',
    detail: 'Some of this has come back. The rest stayed with them.',
    inFlight: false,
    debited: true,
  },
  EXPIRED: {
    label: 'Expired',
    tone: 'neutral',
    detail: 'Nobody acted in time, so this lapsed. No money moved.',
    inFlight: false,
    debited: false,
  },
  /**
   * The state this whole file exists to get right.
   *
   * NOT carmine, and the label deliberately does not contain the word "failed". The rail never
   * answered, the money is held in suspense, and a human is resolving it. Telling the user it failed
   * would be a lie that also invites them to pay again.
   */
  DEEMED: {
    label: 'Still confirming',
    tone: 'latent',
    detail:
      'The payment network has not confirmed this yet. Your money is safe while we check — we will not let it be paid twice.',
    inFlight: false,
    debited: true,
  },
};

export function txnStatus(status: TxnStatus): StatusPresentation {
  return TXN_STATUS[status];
}
