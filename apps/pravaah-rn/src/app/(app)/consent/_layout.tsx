import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { Type, platformFamily, usePalette } from '@/theme';

/**
 * The consent stack: dashboard → request → live status.
 *
 * Same header treatment as the KYC stack, deliberately: these are both "a task
 * inside the app", and giving them different chrome would make the app feel like
 * two apps stitched together.
 */
export default function ConsentLayout() {
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
