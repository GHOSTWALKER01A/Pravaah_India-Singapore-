import { PayScreen } from '@/features/payments/screens/pay-screen';

/**
 * The Pay TAB — a top-level destination, because moving money is something people
 * open the app to do, not a detail behind the passport.
 *
 * This file IS `/pay`. There is deliberately no `app/(app)/payments/index.tsx`:
 * `(app)` and `(tabs)` are groups, and groups contribute no path segment, so an
 * index there would resolve to a colliding route — the same collision that made
 * the app fail to start when the score tab was added.
 *
 * `app/(app)/payments/` therefore holds only CHILD routes (`send`, `scan`, `qr`,
 * `payees`, `autopay`, `disputes`, `statement`, `topup`, `withdraw`, `[id]`),
 * exactly as `app/(app)/score/` and `app/(app)/kyc/` hold children for their tabs.
 */
export default function PayRoute() {
  return <PayScreen />;
}
