import { type Href } from 'expo-router';

/**
 * Typed route paths for expo-router. Keeps navigation strings in one place
 * so screens never hard-code hrefs.
 */
export const ROUTES = {
  AUTH: {
    SEND_OTP: '/(auth)/send-otp',
    VERIFY_OTP: '/(auth)/verify-otp',
    ONBOARDING: '/(auth)/onboarding',
  },
  TABS: {
    HOME: '/(app)/(tabs)',
    KYC: '/(app)/(tabs)/kyc',
    // M2's main screen IS this tab. There is no `/(app)/score` index route —
    // `(app)` and `(tabs)` are groups and contribute no path segment, so an index
    // there would resolve to `/score` too and collide with the tab.
    SCORE: '/(app)/(tabs)/score',
    PROFILE: '/(app)/(tabs)/profile',
  },
  // Cast to Href (matches the flow.ts convention) so these are stable even
  // while expo-router's generated route types are mid-regeneration.
  CONSENT: {
    DASHBOARD: '/(app)/consent' as Href,
    NEW: '/(app)/consent/new' as Href,
    DETAIL: (id: string) =>
      ({ pathname: '/(app)/consent/[id]', params: { id } }) as Href,
  },
  /**
   * M2 child screens pushed on top of the Reputation tab. The tab itself is
   * TABS.SCORE — `/(app)/score` intentionally has no index route, mirroring how
   * `/(app)/kyc` holds only children for the Verify tab.
   */
  SCORE: {
    HISTORY: '/(app)/score/history' as Href,
    // The separate, optional consent for audit-only protected attributes.
    FAIRNESS: '/(app)/score/fairness' as Href,
  },
  KYC: {
    STATUS: '/(app)/kyc/status',
    // Shared across rails
    LIVENESS: '/(app)/kyc/liveness',
    FACE_MATCH: '/(app)/kyc/face-match',
    SANCTIONS: '/(app)/kyc/sanctions',
    INDIA: {
      PAN: '/(app)/kyc/india/pan',
      AADHAAR: '/(app)/kyc/india/aadhaar',
      BANK: '/(app)/kyc/india/bank',
    },
    SINGAPORE: '/(app)/kyc/singapore',
  },
} as const;
