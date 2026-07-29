import { Stack, useLocalSearchParams } from 'expo-router';

import { PremiumsScreen } from '@/features/insurance/screens';

export default function PremiumsRoute() {
  const { policyId } = useLocalSearchParams<{ policyId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Premium history' }} />
      <PremiumsScreen policyId={policyId} />
    </>
  );
}
