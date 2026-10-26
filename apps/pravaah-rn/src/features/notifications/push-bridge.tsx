import { router } from 'expo-router';
import { useEffect } from 'react';

import { kycService } from '@/api';
import { ROUTES } from '@/constants/routes.constants';

import { isPushSupported, registerForPushNotificationsAsync } from './push';

type NotificationsModule = typeof import('expo-notifications');
type NotificationResponse = import('expo-notifications').NotificationResponse;

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
    const subscriptions: { remove: () => void }[] = [];

    /**
     * The identifier of the last response routed, so one tap is never routed twice.
     *
     * A tap that LAUNCHES the app is visible two ways: as the "last response" read below, and —
     * on iOS, when the listener is attached quickly enough — through the listener as well.
     * Routing both would push the consent sheet twice, and the second Back would land the
     * holder on a duplicate of the screen they just answered.
     */
    let lastRouted: string | null = null;
    const handle = (response: NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (id === lastRouted) return;
      lastRouted = id;
      routeFromResponse(response);
    };

    const register = async () => {
      const token = await registerForPushNotificationsAsync();
      if (!active || !token) return;
      // Best-effort: a failed registration just means no push this session.
      void kycService.registerPushToken(token).catch(() => undefined);
    };

    void (async () => {
      let Notifications: NotificationsModule;
      try {
        Notifications = await import('expo-notifications');
      } catch {
        // The native module is missing from this binary (a dev client built before the
        // dependency was added). Push is best-effort; the rest of the app must still run.
        return;
      }
      if (!active) return;

      // Foreground display behaviour.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      subscriptions.push(Notifications.addNotificationResponseReceivedListener(handle));

      /**
       * The tap that STARTED the app.
       *
       * The listener above only hears taps that arrive while JS is running. When the app was
       * killed, the tap that launches it happened before this effect existed, so without this
       * read a peer-scan notification opened the app on the home tab — and the person standing
       * there waiting for an approval got nothing. Cleared once routed, so a remount of this
       * bridge (sign-out and back in) does not replay a stale tap.
       */
      const launchResponse = Notifications.getLastNotificationResponse();
      if (launchResponse) {
        handle(launchResponse);
        Notifications.clearLastNotificationResponse();
      }

      /**
       * APNs and FCM rotate device tokens — after a restore to a new phone, an app data clear,
       * or at the provider's discretion. The Expo token is derived from the device token, so
       * when the device token changes the one the server holds silently stops delivering.
       * Re-registering on the change keeps push working without waiting for a relaunch.
       */
      subscriptions.push(
        Notifications.addPushTokenListener(() => {
          void register();
        }),
      );

      await register();
    })();

    return () => {
      active = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  return null;
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
function routeFromResponse(response: NotificationResponse): void {
  const data = response.notification.request.content.data as
    | { kind?: string; requestId?: string }
    | undefined;

  // A person scanning the holder's code, or (M7) a registered organisation asking by
  // Pravaah ID. Both land on the same consent sheet — it tells the two apart itself.
  if (
    (data?.kind === 'passport.peer_request' ||
      data?.kind === 'passport.partner_request') &&
    data.requestId
  ) {
    router.push(ROUTES.PASSPORT.REQUEST(data.requestId));
    return;
  }
  router.push(ROUTES.KYC.STATUS);
}
