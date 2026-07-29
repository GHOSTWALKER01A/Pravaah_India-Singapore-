import { ReputationScreen } from '@/features/score/reputation-screen';

/**
 * The Reputation SCREEN, at `/score` — a pushed destination, no longer a tab.
 *
 * It left the tab bar for two reasons. The bar was at the five-destination ceiling both platforms set
 * (iOS 2–5, Material 3–5) with no room for the scan action; and the tab was redundant with the
 * Passport tab, where DESIGN.md commits the score as the latent image revealed by press-and-hold on
 * the note itself. A bar slot spent on a second door into content already on the first screen is the
 * slot the most-used action in the product needed.
 *
 * This file now legitimately IS `/score`. With no `(tabs)/score.tsx` there is nothing left to collide
 * with — the collision the previous comment warned about was between that tab file and this path, and
 * removing the tab is what resolved it. `history` and `fairness` sit beside this as children.
 *
 * Reached from the passport's own score panel and from the Bearer tab.
 */
export default function ScoreRoute() {
  return <ReputationScreen />;
}
