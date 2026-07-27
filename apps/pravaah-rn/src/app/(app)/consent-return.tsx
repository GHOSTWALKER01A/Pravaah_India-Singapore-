import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen, Spinner, Text } from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';
import { Space } from '@/theme';

/**
 * The deep-link landing after the Account Aggregator's approval page.
 *
 * A bounce screen, visible for a fraction of a second — but it is what the user
 * sees at the exact moment they are wondering whether their approval registered,
 * so it says which thing it is doing rather than showing a bare spinner.
 */
export default function ConsentReturnScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();

  useEffect(() => {
    const dest: Href = id ? ROUTES.CONSENT.DETAIL(id) : ROUTES.CONSENT.DASHBOARD;
    // replace() so this screen never sits in the back stack — swiping back to a
    // redirect that immediately redirects again is a trap.
    router.replace(dest);
  }, [id]);

  return (
    <Screen scroll={false}>
      <Stack.Screen options={{ title: 'Returning' }} />
      <View style={styles.center}>
        <Spinner size={24} label="Returning to your consent" />
        <Text role="bodySm" tone="dim" center>
          Back from your Account Aggregator — checking where your consent got to.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.lg },
});
