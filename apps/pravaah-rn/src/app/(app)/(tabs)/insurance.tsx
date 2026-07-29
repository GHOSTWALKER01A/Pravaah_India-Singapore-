import { InsuranceScreen } from '@/features/insurance/screens';

/**
 * The Cover tab.
 *
 * Thin, like every other tab file: the marketplace lives in the feature so it can be reordered,
 * tested, or reached from a second entry point without touching the router.
 *
 * This replaces the "available here soon" placeholder that stood here — the module it was
 * waiting for is now built, and the padlock it used as its icon has been replaced by the
 * `cover` escutcheon in the tab bar. A padlock on a tab means "you cannot go here", which was
 * precisely the wrong thing to say about the one product in the app built for people who are
 * usually refused.
 */
export default function InsuranceTab() {
  return <InsuranceScreen />;
}
