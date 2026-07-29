import { Stack } from 'expo-router';

/**
 * One Stack over every M5 child screen, mirroring `payments/_layout.tsx`.
 *
 * Flat rather than nested per sub-flow, for the reason the payments and KYC layouts both give:
 * expo-router groups contribute no path segment, so a `claims/_layout.tsx` would add a second
 * navigator with its own header and its own back behaviour without adding a single route. Each
 * screen declares its own title next to the content it names.
 *
 * The header stays ON. These are pushed task screens, and the platform's own back affordance —
 * iOS's edge swipe, Android's predictive Back — is the muscle memory somebody uses to escape a
 * form. A claimant who cannot get out of an upload screen will force-quit, and the flow has to
 * survive that: filing and finalising are separate calls precisely so a force-quit mid-upload
 * loses one photograph rather than the claim.
 */
export default function InsuranceLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerLargeTitle: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    />
  );
}
