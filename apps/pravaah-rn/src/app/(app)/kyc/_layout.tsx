import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { Type, platformFamily, usePalette } from '@/theme';

/**
 * One stack for the whole verification flow — India, Singapore, and the shared
 * steps. Each screen sets its own title, so the header always names the step.
 *
 * The header is deliberately inline and minimal rather than a large title: these
 * are steps inside a task, and the screen's own denomination heading is the title.
 * A second large title in the bar would say the same thing twice.
 *
 * `gestureEnabled` is left on so the iOS edge-swipe back works — but each step
 * screen uses `router.replace` on success, so swiping back never lands on a step
 * that has already been cleared.
 */
export default function KycLayout() {
  const p = usePalette();

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Back',
        headerTransparent: false,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: p.ground },
        headerTintColor: p.latent,
        // `title`, not `legend`: the bar's title is sentence-case screen names
        // like "PAN verification", and legend's 11pt tracked caps is a label
        // style that becomes unreadable when it has to carry a sentence.
        headerTitleStyle: {
          fontFamily: platformFamily(Type.title.fontFamily),
          fontSize: Type.title.fontSize,
          color: p.ink,
        },
        headerTitleAlign: Platform.OS === 'ios' ? 'center' : 'left',
        contentStyle: { backgroundColor: p.ground },
      }}
    />
  );
}
