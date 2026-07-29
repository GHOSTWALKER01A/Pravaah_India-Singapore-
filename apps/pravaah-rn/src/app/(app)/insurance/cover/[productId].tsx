import { Stack, useLocalSearchParams } from 'expo-router';

import { CoverScreen } from '@/features/insurance/screens';

/**
 * Step 1 of buying — how much cover.
 *
 * The param is read here and passed as a prop, so `CoverScreen` is a plain component that can
 * be rendered from a test or from a second entry point without the router.
 */
export default function CoverRoute() {
  const { productId } = useLocalSearchParams<{ productId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Choose your cover' }} />
      <CoverScreen productId={productId} />
    </>
  );
}
