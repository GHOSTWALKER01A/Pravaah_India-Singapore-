import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
  type Theme,
} from '@react-navigation/native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '@/context/auth-context';
import {
  ThemeProvider,
  Type,
  useAppFonts,
  usePalette,
  useScheme,
} from '@/theme';

// Held until the note's own faces are ready. A frame rendered in the system font
// and then reflowed into Bodoni is a visible jump on the first screen the user
// ever sees, which is the screen that has to look most trustworthy.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const fontsReady = useAppFonts();

  useEffect(() => {
    if (fontsReady) void SplashScreen.hideAsync();
  }, [fontsReady]);

  if (!fontsReady) return null;

  return (
    // GestureHandlerRootView is required at the root for gesture-driven
    // navigation (the iOS edge-swipe back that react-native-screens installs).
    // Its absence is why the incumbent app's back gesture was inconsistent.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <Navigation />
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Separate component so it sits INSIDE `ThemeProvider` and can read the palette.
 * React Navigation needs its own theme object for the pieces the app does not
 * draw itself: the screen background behind a push transition, the header, and
 * the card shadow. Left at its defaults, a white navigator background flashes
 * behind every dark-mode transition.
 */
function Navigation() {
  const p = usePalette();
  const scheme = useScheme();

  const navTheme = useMemo<Theme>(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === 'dark',
      colors: {
        ...base.colors,
        primary: p.latent,
        background: p.ground,
        card: p.ground,
        text: p.ink,
        border: p.rule,
        notification: p.carmine,
      },
      fonts: base.fonts,
    };
  }, [scheme, p]);

  return (
    <NavThemeProvider value={navTheme}>
      {/* The bar's own content, not a background: on the rag sheet the icons must
          be dark, under UV they must be light. `style` here names the CONTENT. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />

      <Stack
        screenOptions={{
          headerShown: false,
          // Both platforms get their native push. The incumbent left this at the
          // default with headers off, so an iOS user got a slide with no back
          // affordance at all on the KYC stack.
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: p.ground },
          headerStyle: { backgroundColor: p.ground },
          headerTintColor: p.ink,
          headerTitleStyle: {
            fontFamily: Type.title.fontFamily,
            fontSize: Type.title.fontSize,
          },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
    </NavThemeProvider>
  );
}
