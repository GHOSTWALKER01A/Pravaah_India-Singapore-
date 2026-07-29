import { Stack } from 'expo-router';

import { PoliciesScreen } from '@/features/insurance/screens';

export default function PoliciesRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Your cover' }} />
      <PoliciesScreen />
    </>
  );
}
