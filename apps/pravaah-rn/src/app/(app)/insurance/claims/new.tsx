import { Stack, useLocalSearchParams } from 'expo-router';

import { FileClaimScreen } from '@/features/insurance/screens';

/**
 * File a claim against one policy.
 *
 * `new` is a STATIC segment, so it takes precedence over the sibling `[claimId]` directory —
 * which is why this can live beside it without `/claims/new` being read as a claim whose id is
 * the word "new".
 *
 * The policy arrives as a search param rather than a path segment because the subject of this
 * screen is the CLAIM being created; the policy is the thing it is filed against.
 */
export default function NewClaimRoute() {
  const { policyId } = useLocalSearchParams<{ policyId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Make a claim' }} />
      <FileClaimScreen policyId={policyId} />
    </>
  );
}
