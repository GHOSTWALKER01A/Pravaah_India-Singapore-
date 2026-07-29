import { Tabs, useRouter } from 'expo-router';

import { TabBar } from '@/components/ui';
import { ROUTES } from '@/constants/routes.constants';

export default function TabsLayout() {
  const router = useRouter();

  return (
    <Tabs
      tabBar={(props) => (
        <TabBar {...props} onScan={() => router.push(ROUTES.PAY.SCAN)} />
      )}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Passport' }} />
      <Tabs.Screen name="kyc" options={{ title: 'Verify' }} />
      <Tabs.Screen name="pay" options={{ title: 'Pay' }} />
      <Tabs.Screen name="insurance" options={{ title: 'Insurance' }} />
    </Tabs>
  );
}
