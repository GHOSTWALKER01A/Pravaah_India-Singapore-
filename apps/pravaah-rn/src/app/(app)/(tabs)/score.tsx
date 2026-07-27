import { ReputationScreen } from '@/features/score/reputation-screen';

/**
 * The Reputation TAB — a top-level destination, because the score is the product,
 * not a detail hidden behind the passport.
 *
 * This file IS `/score`. There is deliberately no `app/(app)/score/index.tsx`:
 * `(app)` and `(tabs)` are groups, and groups contribute no path segment, so an
 * index there would resolve to `/score` as well and collide with this file. That
 * collision is what made the app fail to start.
 *
 * `app/(app)/score/` therefore holds only CHILD routes (`history`, `fairness`),
 * exactly as `app/(app)/kyc/` holds children for the Verify tab.
 */
export default function ScoreTab() {
  return <ReputationScreen />;
}
