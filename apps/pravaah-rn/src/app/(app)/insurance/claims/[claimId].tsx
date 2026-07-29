import { Stack, useLocalSearchParams } from 'expo-router';

import { ClaimScreen } from '@/features/insurance/screens';

export default function ClaimRoute() {
  const { claimId } = useLocalSearchParams<{ claimId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Your claim' }} />
      <ClaimScreen claimId={claimId} />
    </>
  );
}
