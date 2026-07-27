import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { Type, platformFamily, usePalette } from '@/theme';

/**
 * The score's child routes (history, fairness).
 *
 * Identical chrome to the consent and KYC stacks, deliberately: the user moves
 * between data sharing and the score it powers, and differing headers would make
 * that feel like leaving the app.
 *
 * There is no `index` here — `(tabs)/score.tsx` IS `/score`. Groups contribute no
 * path segment, so an index in this folder would resolve to `/score` too and
 * collide with the tab.
 */
export default function ScoreLayout() {
  const p = usePalette();

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Back',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: p.ground },
        headerTintColor: p.latent,
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
