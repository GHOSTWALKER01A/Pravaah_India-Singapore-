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

      /**
       * Route a tap by what the notification was ABOUT.
       *
       * This used to send every tap to the KYC status screen, which was fine while a KYC
       * decision was the only thing that could push. It is not any more: a peer scan asks
       * the holder to approve a disclosure, and somebody is standing in front of them
       * waiting — landing them on their own verification checklist instead of the consent
       * sheet would make the notification worse than useless.
       *
       * The `kind` is read from the payload the server sends and matched exhaustively, with
       * the old behaviour as the fallback so any notification predating this switch still
       * goes where it always did.
       */
      subscription = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          const data = response.notification.request.content.data as
            | { kind?: string; requestId?: string }
            | undefined;

          if (data?.kind === 'passport.peer_request' && data.requestId) {
            router.push(ROUTES.PASSPORT.REQUEST(data.requestId));
            return;
          }
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
