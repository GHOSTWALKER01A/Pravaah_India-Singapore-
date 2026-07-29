import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { Type, platformFamily, usePalette } from '@/theme';

/**
 * The security stack — devices and activity.
 *
 * Identical chrome to the consent, KYC, score and passport stacks, deliberately: a user who
 * came here because something worried them should not also feel they have left the app.
 * Differing headers on the security screens would be the worst place in the product to
 * introduce that doubt.
 */
export default function SecurityLayout() {
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
