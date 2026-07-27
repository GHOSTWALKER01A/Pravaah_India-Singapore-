import { Stack } from 'expo-router';

import { AuthGuard } from '@/components/common/auth-guard';
import { PushNotificationsBridge } from '@/features/notifications/push-bridge';

export default function AppLayout() {
  return (
    <AuthGuard>
      <PushNotificationsBridge />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="kyc" />
        <Stack.Screen name="consent" />
      </Stack>
    </AuthGuard>
  );
}
