import { Stack } from 'expo-router';

import { ClaimsScreen } from '@/features/insurance/screens';

export default function ClaimsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Claims' }} />
      <ClaimsScreen />
    </>
  );
}
