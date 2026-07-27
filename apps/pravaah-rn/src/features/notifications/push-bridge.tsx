import { router } from 'expo-router';
import { useEffect } from 'react';

import { kycService } from '@/api';
import { ROUTES } from '@/constants/routes.constants';

import { isPushSupported, registerForPushNotificationsAsync } from './push';

/**
 * Bridges the device to push notifications. Rendered inside the AuthGuard, so
 * it only runs once the user is signed in: it registers the device's Expo push
 * token with the backend and routes a tap on a decision notification to the
 * verification status screen. Renders nothing.
 *
 * `expo-notifications` is imported LAZILY and only when push is supported —
 * Expo Go (SDK 53+) can't do remote push and even importing the module there
 * throws, so we must never load it in that environment.
 */
export function PushNotificationsBridge() {
  useEffect(() => {
    if (!isPushSupported()) return;

    let active = true;
    let subscription: { remove: () => void } | undefined;

    void (async () => {
      const Notifications = await import('expo-notifications');

      // Foreground display behaviour.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      const token = await registerForPushNotificationsAsync();
      if (!active) return;
      if (token) {
        // Best-effort: a failed registration just means no push this session.
        void kycService.registerPushToken(token).catch(() => undefined);
      }

      // Tapping a decision notification opens the status screen (which forwards
      // to the passport if the user is verified).
      subscription = Notifications.addNotificationResponseReceivedListener(
        () => {
          router.push(ROUTES.KYC.STATUS);
        },
      );
    })();

    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);

  return null;
}
