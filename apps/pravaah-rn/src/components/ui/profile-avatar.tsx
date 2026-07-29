import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Icon } from './icon';
import { Press } from './pressable';
import { Radius, usePalette } from '@/theme';

export function ProfileAvatar() {
  const router = useRouter();
  const p = usePalette();

  return (
    <Press
      onPress={() => router.push('/profile')}
      depth="none"
      feedback="select"
      radius={Radius.pill}
      accessibilityRole="button"
      accessibilityLabel="Open profile"
      style={styles.container}
    >
      <View style={[styles.avatar, { backgroundColor: p.field, borderColor: p.rule, borderWidth: 1 }]}>
        <Icon name="bearer" size={20} color={p.onField} />
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 20, // Circular touch target
    overflow: 'hidden',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
