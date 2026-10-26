/*
 * The navigation theme comes from `expo-router`, NOT `@react-navigation/native`.
 *
 * Since SDK 56 expo-router vendors its own copy of React Navigation instead of depending on
 * the `@react-navigation/*` packages. Importing `ThemeProvider` from the upstream package
 * would still type-check if a stale copy were hoisted in node_modules — and would then
 * provide a theme on a React context the router's navigators never read, so every header
 * and transition background silently fell back to the default white.
 */
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
  Stack,
  type Theme,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
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
void SplashScreen.preventAutoHideAsync().catch(() => {
  /* Already hidden (a fast refresh re-ran this module). Nothing to hold. */
});

// Cross-fade off the splash instead of cutting. The splash ground and the first screen's
// ground are the same green, so a fade reads as the note settling rather than a new app
// replacing it.
SplashScreen.setOptions({ duration: 250, fade: true });

export default function RootLayout() {
  const fontsReady = useAppFonts();

  useEffect(() => {
    if (fontsReady) void SplashScreen.hideAsync().catch(() => undefined);
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

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme: Theme = {
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

  /*
   * The ROOT view's colour, beneath React entirely.
   *
   * The navigator theme above paints every screen, but not the native window behind them —
   * and that window shows through whenever nothing React-drawn covers it: the keyboard
   * sliding in on Android, a modal's rubber-band overscroll on iOS, the frame between a
   * screen unmounting and the next mounting. It defaults to white, so in dark mode each of
   * those moments was a white flash on a green note. Following the scheme keeps it the same
   * ground as whatever is about to be drawn on top of it.
   */
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(p.ground).catch(() => undefined);
  }, [p.ground]);

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
