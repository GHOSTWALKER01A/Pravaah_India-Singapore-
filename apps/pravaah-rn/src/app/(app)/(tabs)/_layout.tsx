import { Tabs } from 'expo-router';

import { TabBar } from '@/components/ui';

/**
 * Four top-level destinations, drawn by the app's own engraved bar.
 *
 * `tabBar` replaces the stock bar entirely rather than theming it, because the
 * pieces that needed to change — the glyphs, the active indicator, the field
 * ground, the motion between destinations — are not reachable through
 * `screenOptions`. What IS still delegated to the navigator is everything that
 * should be: the routes, the focus state, `tabPress` (so tapping the active tab
 * pops its stack), and the platform's own screen lifecycle.
 *
 * Labels stay on. Icon-only bars test badly with exactly this audience — reading
 * English as a second or third language, using the app rarely, and needing to be
 * certain which destination revokes their data.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // Deliberately no `tabBarHideOnKeyboard`: that option is implemented by
        // react-navigation's DEFAULT tab bar and is silently ignored by a custom
        // one, so setting it would only look like it was handled. It is not needed
        // here either — none of the four tab screens has a text input. Every input
        // in the app lives on a pushed stack screen with no tab bar over it.
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Passport' }} />
      <Tabs.Screen name="kyc" options={{ title: 'Verify' }} />
      <Tabs.Screen name="score" options={{ title: 'Score' }} />
      <Tabs.Screen name="profile" options={{ title: 'Bearer' }} />
    </Tabs>
  );
}
