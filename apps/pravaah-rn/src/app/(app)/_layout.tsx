import { Stack } from 'expo-router';

import { AuthGuard } from '@/components/common/auth-guard';
import { PushNotificationsBridge } from '@/features/notifications/push-bridge';
import { DeviceBindingBridge } from '@/features/security/device-bridge';

export default function AppLayout() {
  return (
    <AuthGuard>
      <PushNotificationsBridge />
      {/*
        M6 device binding, alongside the push bridge and for the same reasons: it needs a
        session, it runs once, and it has no destination of its own.

        `enabled` is passed as a literal rather than read from auth state because this
        component only mounts INSIDE `AuthGuard` — by the time it renders, a session exists.
        Threading a flag through would add a prop whose only possible value is `true`.

        Rendered ABOVE the `Stack` so its sheet overlays whatever screen the user landed on.
        Below it, the stack's own background would paint over the scrim.
      */}
      <DeviceBindingBridge enabled />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="kyc" />
        <Stack.Screen name="consent" />
        {/*
          Declared for the same reason the others are: this layout is the one place the app's
          top-level destinations are listed, rather than being discovered from the filesystem
          in an order that can differ per platform.
        */}
        <Stack.Screen name="security" />
      </Stack>
    </AuthGuard>
  );
}
