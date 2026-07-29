import { Stack, useLocalSearchParams } from 'expo-router';

import { ClaimDocumentsScreen } from '@/features/insurance/screens';

export default function ClaimDocumentsRoute() {
  const { claimId } = useLocalSearchParams<{ claimId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Your documents' }} />
      <ClaimDocumentsScreen claimId={claimId} />
    </>
  );
}
