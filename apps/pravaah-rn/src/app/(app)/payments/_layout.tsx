import { Stack } from 'expo-router';

/**
 * One Stack over every M4 child screen, mirroring `kyc/_layout.tsx`.
 *
 * Flat rather than nested per sub-flow, and that is the same decision the KYC layout made for
 * the same reason: expo-router groups contribute no path segment, so a `send/_layout.tsx` would
 * add a second navigator with its own header and its own back behaviour without adding a single
 * route. Each screen declares its own `<Stack.Screen options={{ title }} />`, so the title is
 * next to the content it names.
 *
 * The header stays ON here, unlike the tabs: these are pushed task screens, and the platform's
 * own back affordance — iOS's edge swipe, Android's predictive Back — is the muscle memory a
 * payments flow must not break. A user who cannot get out of an amount screen will force-quit,
 * and a force-quit mid-payment is exactly the case the idempotency key exists to survive.
 */
export default function PaymentsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        // A pushed screen carries an inline title; large titles belong to top-level destinations.
        headerLargeTitle: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    />
  );
}
