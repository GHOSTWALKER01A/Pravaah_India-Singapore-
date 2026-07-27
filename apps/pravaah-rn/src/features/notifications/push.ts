import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

/**
 * Whether remote push is usable here. It needs a real device AND a dev/
 * standalone build — Expo Go dropped remote push in SDK 53, and even importing
 * `expo-notifications` there runs a side-effect that throws. So we gate on this
 * BEFORE ever importing the module.
 */
export function isPushSupported(): boolean {
  return (
    Device.isDevice &&
    Constants.executionEnvironment !== ExecutionEnvironment.StoreClient
  );
}

/**
 * Registers the device for Expo push and returns its Expo push token
 * (`ExponentPushToken[...]`), or null if unavailable (Expo Go, simulator, or
 * permission denied). `expo-notifications` is imported lazily so Expo Go never
 * loads its push side-effects. Never throws — push is best-effort.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    if (!isPushSupported()) return null;

    // Lazy import: only reached in a dev/standalone build, never in Expo Go.
    const Notifications = await import('expo-notifications');

    // Android must have a notification channel before a token is requested.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.granted;
    }
    if (!granted) return null;

    // projectId comes from app.json → extra.eas.projectId.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) return null;

    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data;
  } catch {
    return null;
  }
}
