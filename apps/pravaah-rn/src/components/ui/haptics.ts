/**
 * Haptics, tied to meaning.
 *
 * The rule from DESIGN.md: haptics mark events that MATTER, never ordinary taps.
 * A phone that buzzes on every press trains the user to ignore it, which spends
 * the one channel that could have told them a check actually cleared.
 *
 *   select    — a tab or segment changed. The lightest tick there is.
 *   commit    — a step completed, a consent created. Something is now true.
 *   cleared   — the whole verification passed. Fires once, ever, per user.
 *   refused   — a check failed or a code was wrong.
 *   destroy   — the revoke confirmation. Heavy, single, and deliberate.
 *
 * Every call is fire-and-forget and swallows its own failure: haptics are absent
 * on most emulators, on web, and on devices where the user has switched them off,
 * and none of those is an error worth surfacing or crashing on.
 */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// react-native-web has no haptics and Android's older impl throws on some OEMs.
const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

function run(fn: () => Promise<void>): void {
  if (!enabled) return;
  void fn().catch(() => {
    /* A missing vibrator is not an error the user needs to hear about. */
  });
}

export const haptic = {
  select: () => run(() => Haptics.selectionAsync()),

  commit: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),

  cleared: () =>
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),

  refused: () =>
    run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),

  destroy: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
} as const;
