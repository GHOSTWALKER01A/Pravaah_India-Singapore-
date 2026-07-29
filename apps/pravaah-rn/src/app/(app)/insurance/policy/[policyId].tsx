import { Stack, useLocalSearchParams } from 'expo-router';

import { PolicyScreen } from '@/features/insurance/screens';

/**
 * One policy.
 *
 * A directory with `index.tsx` rather than a flat `[policyId].tsx`, because the premium history
 * is a child of this route — `policy/[policyId]/premiums` — and expo-router cannot have both a
 * file and a directory at the same segment.
 */
export default function PolicyRoute() {
  const { policyId } = useLocalSearchParams<{ policyId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Your policy' }} />
      <PolicyScreen policyId={policyId} />
    </>
  );
}
